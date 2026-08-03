package agentrun_test

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/agentrun"
)

// fakeConn is an in-memory NATS: handlers per subject, published messages
// recorded in order.
type fakeConn struct {
	mu         sync.Mutex
	handlers   map[string]func([]byte)
	published  []publishedMsg
	publishErr error
}

type publishedMsg struct {
	Subject string
	Down    agentrun.DownMessage
}

func newFakeConn() *fakeConn {
	return &fakeConn{handlers: map[string]func([]byte){}}
}

func (c *fakeConn) Subscribe(subject string, handler func([]byte)) (agentrun.Subscription, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.handlers[subject] = handler
	return fakeSub{c: c, subject: subject}, nil
}

func (c *fakeConn) Publish(subject string, data []byte) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.publishErr != nil {
		return c.publishErr
	}
	var down agentrun.DownMessage
	if err := json.Unmarshal(data, &down); err != nil {
		return err
	}
	c.published = append(c.published, publishedMsg{Subject: subject, Down: down})
	return nil
}

// deliver plays the agent's part: publish an up-message on its up subject.
func (c *fakeConn) deliver(t *testing.T, subject string, msg agentrun.UpMessage) {
	t.Helper()
	c.mu.Lock()
	handler := c.handlers[subject]
	c.mu.Unlock()
	require.NotNil(t, handler, "nothing subscribed to %s", subject)
	raw, err := json.Marshal(msg)
	require.NoError(t, err)
	handler(raw)
}

func (c *fakeConn) sent() []publishedMsg {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]publishedMsg(nil), c.published...)
}

func (c *fakeConn) acks() []int {
	var out []int
	for _, m := range c.sent() {
		if m.Down.Type == agentrun.DownReplyAck && m.Down.AckSeq != nil {
			out = append(out, *m.Down.AckSeq)
		}
	}
	return out
}

type fakeSub struct {
	c       *fakeConn
	subject string
}

func (s fakeSub) Unsubscribe() error {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	delete(s.c.handlers, s.subject)
	return nil
}

// fakeSignaler records signals and can be made to fail.
type fakeSignaler struct {
	mu      sync.Mutex
	signals []recordedSignal
	err     error
}

type recordedSignal struct {
	WorkflowID string
	Name       string
	Msg        agentrun.UpMessage
}

func (s *fakeSignaler) SignalWorkflow(_ context.Context, workflowID, _ string, name string, arg any) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.err != nil {
		return s.err
	}
	s.signals = append(s.signals, recordedSignal{workflowID, name, arg.(agentrun.UpMessage)})
	return nil
}

func (s *fakeSignaler) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.signals)
}

const runID = "agentrun-swe-1"

func attached(t *testing.T) (*agentrun.Bridge, *fakeConn, *fakeSignaler, agentrun.Subjects) {
	t.Helper()
	conn := newFakeConn()
	signaler := &fakeSignaler{}
	bridge := agentrun.NewBridge(conn, signaler, "")
	require.NoError(t, bridge.Attach(runID, "conversation-abc"))
	return bridge, conn, signaler, agentrun.SubjectsFor(runID, "")
}

// Diverging from upstream's subject naming would make an unmodified agent
// unreachable, which is the entire point of this package.
func TestSubjectsMatchUpstream(t *testing.T) {
	s := agentrun.SubjectsFor("agentrun-x", "")
	require.Equal(t, "agent.agentrun-x.up", s.Up)
	require.Equal(t, "agent.agentrun-x.down", s.Down)

	custom := agentrun.SubjectsFor("agentrun-x", "acme")
	require.Equal(t, "acme.agentrun-x.up", custom.Up)
}

func TestUpMessagesBecomeWorkflowSignals(t *testing.T) {
	_, conn, signaler, subjects := attached(t)

	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 1, Type: agentrun.UpReady})
	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 2, Type: agentrun.UpProgress, Message: "cloning"})

	require.Equal(t, 2, signaler.count())
	require.Equal(t, "conversation-abc", signaler.signals[0].WorkflowID)
	require.Equal(t, agentrun.UpSignalPrefix+runID, signaler.signals[0].Name)
	require.Equal(t, agentrun.UpReady, signaler.signals[0].Msg.Type)
	require.Equal(t, "cloning", signaler.signals[1].Msg.Message)
}

// ADR 0033's hold exists because the process holding the wait can vanish. A
// workflow cannot, so the moment Temporal has the signal the hold has done its
// job — which that ADR names as its own exit condition.
func TestConcludingMessagesAreAckedAndNarrationIsNot(t *testing.T) {
	_, conn, _, subjects := attached(t)

	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 1, Type: agentrun.UpProgress, Message: "working"})
	require.Empty(t, conn.acks(), "narration is commentary; holding it would be pointless")

	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 2, Type: agentrun.UpReply, Message: "done", Final: true})
	require.Equal(t, []int{2}, conn.acks())

	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 3, Type: agentrun.UpFailed, Code: "boom", Message: "it broke"})
	require.Equal(t, []int{2, 3}, conn.acks())
}

// A question is a non-final reply, and losing one strands the conversation
// exactly as badly as losing an answer — so it is held and acked too.
func TestANonFinalReplyIsAckedAsWell(t *testing.T) {
	_, conn, _, subjects := attached(t)
	conn.deliver(t, subjects.Up, agentrun.UpMessage{
		AgentRunID: runID, Seq: 1, Type: agentrun.UpReply, Message: "which branch?", Final: false,
	})
	require.Equal(t, []int{1}, conn.acks())
}

// THE correctness property. The ack tells the agent it may stop holding, so it
// must not be sent until the message is somewhere that survives this process. A
// bridge that acked first and crashed would lose the turn's whole outcome —
// exactly the failure ADR 0033 was written about.
func TestNoAckWhenTheSignalFailed(t *testing.T) {
	conn := newFakeConn()
	signaler := &fakeSignaler{err: errors.New("temporal unavailable")}
	bridge := agentrun.NewBridge(conn, signaler, "")
	require.NoError(t, bridge.Attach(runID, "conversation-abc"))
	subjects := agentrun.SubjectsFor(runID, "")

	conn.deliver(t, subjects.Up, agentrun.UpMessage{
		AgentRunID: runID, Seq: 1, Type: agentrun.UpReply, Message: "done", Final: true,
	})
	require.Empty(t, conn.acks(), "no ack means the agent keeps holding, which is the recoverable state")

	// The agent re-offers; now Temporal is back.
	signaler.mu.Lock()
	signaler.err = nil
	signaler.mu.Unlock()

	conn.deliver(t, subjects.Up, agentrun.UpMessage{
		AgentRunID: runID, Seq: 1, Type: agentrun.UpReply, Message: "done", Final: true,
	})
	require.Equal(t, 1, signaler.count(), "the re-offer is what finally lands")
	require.Equal(t, []int{1}, conn.acks())
}

// Re-offers reuse their original seq precisely so a consumer can tell a
// re-offer from a second reply. Signalling twice would deliver the answer twice.
func TestAReOfferIsReAckedButNotReSignalled(t *testing.T) {
	_, conn, signaler, subjects := attached(t)
	reply := agentrun.UpMessage{AgentRunID: runID, Seq: 7, Type: agentrun.UpReply, Message: "done", Final: true}

	conn.deliver(t, subjects.Up, reply)
	conn.deliver(t, subjects.Up, reply)
	conn.deliver(t, subjects.Up, reply)

	require.Equal(t, 1, signaler.count(), "the workflow must see one reply, not three")
	require.Equal(t, []int{7, 7, 7}, conn.acks(),
		"each re-offer is re-acked: the agent is still holding because an earlier ack did not land")
}

func TestDownMessages(t *testing.T) {
	bridge, conn, _, subjects := attached(t)

	require.NoError(t, bridge.Prompt(runID, "use exponential backoff"))
	require.NoError(t, bridge.Cancel(runID, "user abandoned the chat"))
	require.NoError(t, bridge.ToolResult(runID, "call_1", true, "pod-a Running", ""))
	require.NoError(t, bridge.ToolResult(runID, "call_2", false, "", "not permitted"))

	sent := conn.sent()
	require.Len(t, sent, 4)
	for _, m := range sent {
		require.Equal(t, subjects.Down, m.Subject)
		require.Equal(t, runID, m.Down.AgentRunID)
		require.NotEmpty(t, m.Down.TS)
	}

	require.Equal(t, agentrun.DownPrompt, sent[0].Down.Type)
	require.Equal(t, "use exponential backoff", sent[0].Down.Message)
	require.Equal(t, agentrun.DownCancel, sent[1].Down.Type)

	require.Equal(t, agentrun.DownToolResult, sent[2].Down.Type)
	require.Equal(t, "call_1", sent[2].Down.CallID)
	require.True(t, *sent[2].Down.OK)
	require.JSONEq(t, `"pod-a Running"`, string(sent[2].Down.Result))

	require.False(t, *sent[3].Down.OK)
	require.Equal(t, "not permitted", sent[3].Down.Error)

	// Monotonic per-direction sequence, as the protocol requires.
	require.Equal(t, []int{1, 2, 3, 4},
		[]int{sent[0].Down.Seq, sent[1].Down.Seq, sent[2].Down.Seq, sent[3].Down.Seq})
}

// A worker that restarted mid-episode must be able to reach a running agent.
// Subjects derive from the run id, not from local state, so re-attaching is
// enough — which is what makes the bridge itself disposable.
func TestReAttachRebindsToTheWorkflow(t *testing.T) {
	bridge, conn, signaler, subjects := attached(t)

	require.NoError(t, bridge.Attach(runID, "conversation-xyz"))
	conn.deliver(t, subjects.Up, agentrun.UpMessage{AgentRunID: runID, Seq: 1, Type: agentrun.UpProgress, Message: "still here"})

	require.Equal(t, 1, signaler.count())
	require.Equal(t, "conversation-xyz", signaler.signals[0].WorkflowID)
}

func TestDetachStopsBridging(t *testing.T) {
	bridge, conn, signaler, subjects := attached(t)
	bridge.Detach(runID)

	require.NotContains(t, conn.handlers, subjects.Up)
	require.Zero(t, signaler.count())
	require.ErrorContains(t, bridge.Prompt(runID, "hello"), "not attached")
}

func TestUndecodableUpMessageIsIgnored(t *testing.T) {
	conn := newFakeConn()
	signaler := &fakeSignaler{}
	bridge := agentrun.NewBridge(conn, signaler, "")
	require.NoError(t, bridge.Attach(runID, "conversation-abc"))

	conn.handlers[agentrun.SubjectsFor(runID, "").Up]([]byte("not json"))
	require.Zero(t, signaler.count(), "a malformed message must not take the run down")
}
