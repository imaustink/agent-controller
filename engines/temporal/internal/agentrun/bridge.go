package agentrun

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/nats-io/nats.go"
)

// Signaler is the slice of the Temporal client the bridge needs.
type Signaler interface {
	SignalWorkflow(ctx context.Context, workflowID, runID, signalName string, arg any) error
}

// Conn is the slice of a NATS connection the bridge needs, so tests can fake
// it without a server.
type Conn interface {
	Subscribe(subject string, handler func(data []byte)) (Subscription, error)
	Publish(subject string, data []byte) error
}

type Subscription interface {
	Unsubscribe() error
}

// UpSignalPrefix + <agentRunID> is the signal channel a bridged agent's
// up-messages arrive on. One channel per run, so concurrent runs in one
// workflow cannot cross-talk — the same discipline as the tool event bridge.
const UpSignalPrefix = "agent-run-up::"

// Bridge subscribes to a run's up subject and turns each message into a
// workflow signal, publishing down-messages in the other direction.
//
// It is deliberately thin and stateless apart from dedupe: every decision about
// what a message MEANS belongs to the workflow, which is the durable half. The
// bridge's only judgement is when to ack.
type Bridge struct {
	conn     Conn
	signaler Signaler
	prefix   string

	mu     sync.Mutex
	runs   map[string]*bridgedRun
	nextUp int
}

type bridgedRun struct {
	workflowID string
	subjects   Subjects
	sub        Subscription
	// seenSeq dedupes re-offers. ADR 0033's re-offers reuse their original
	// seq precisely so a consumer can tell a re-offer from a second reply, so
	// this is the contract working rather than defensive coding.
	seenSeq map[int]bool
	// downSeq is our own monotonic per-direction counter.
	downSeq int
}

func NewBridge(conn Conn, signaler Signaler, subjectPrefix string) *Bridge {
	return &Bridge{
		conn:     conn,
		signaler: signaler,
		prefix:   subjectPrefix,
		runs:     map[string]*bridgedRun{},
	}
}

// Attach begins bridging an agent run to a workflow. Idempotent: attaching an
// already-attached run rebinds it to the given workflow, which is what a worker
// that restarted mid-run needs.
func (b *Bridge) Attach(agentRunID, workflowID string) error {
	b.mu.Lock()
	if existing, ok := b.runs[agentRunID]; ok {
		existing.workflowID = workflowID
		b.mu.Unlock()
		return nil
	}
	run := &bridgedRun{
		workflowID: workflowID,
		subjects:   SubjectsFor(agentRunID, b.prefix),
		seenSeq:    map[int]bool{},
	}
	b.runs[agentRunID] = run
	b.mu.Unlock()

	sub, err := b.conn.Subscribe(run.subjects.Up, func(data []byte) {
		b.handleUp(agentRunID, data)
	})
	if err != nil {
		b.mu.Lock()
		delete(b.runs, agentRunID)
		b.mu.Unlock()
		return fmt.Errorf("subscribe to %s: %w", run.subjects.Up, err)
	}

	b.mu.Lock()
	run.sub = sub
	b.mu.Unlock()
	return nil
}

// Detach stops bridging a run.
func (b *Bridge) Detach(agentRunID string) {
	b.mu.Lock()
	run, ok := b.runs[agentRunID]
	delete(b.runs, agentRunID)
	b.mu.Unlock()
	if ok && run.sub != nil {
		_ = run.sub.Unsubscribe()
	}
}

func (b *Bridge) handleUp(agentRunID string, data []byte) {
	var msg UpMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		log.Printf("[agent-bridge] %s: undecodable up-message: %v", agentRunID, err)
		return
	}

	b.mu.Lock()
	run, ok := b.runs[agentRunID]
	if !ok {
		b.mu.Unlock()
		return // detached mid-flight
	}
	workflowID := run.workflowID
	duplicate := run.seenSeq[msg.Seq]
	run.seenSeq[msg.Seq] = true
	b.mu.Unlock()

	if duplicate {
		// A re-offer of something already signalled. Re-ack rather than
		// re-signal: the agent is still holding it because our previous ack did
		// not arrive, and signalling twice would deliver the answer twice.
		if msg.IsConcluding() {
			b.ack(agentRunID, msg.Seq)
		}
		return
	}

	// Signal FIRST, ack second. The ordering is the whole correctness argument
	// for acking at all: the ack tells the agent it may stop holding, so it
	// must not be sent until the message is somewhere that survives this
	// process. A crash between these two lines leaves the agent still holding,
	// which is precisely the recoverable state.
	if err := b.signaler.SignalWorkflow(context.Background(), workflowID, "",
		UpSignalPrefix+agentRunID, msg); err != nil {
		log.Printf("[agent-bridge] %s: signal failed, NOT acking so the agent keeps holding: %v", agentRunID, err)
		b.mu.Lock()
		if run, ok := b.runs[agentRunID]; ok {
			delete(run.seenSeq, msg.Seq) // let the next re-offer retry
		}
		b.mu.Unlock()
		return
	}

	if msg.IsConcluding() {
		b.ack(agentRunID, msg.Seq)
	}
}

// ack releases the agent's hold on a concluding message.
//
// Upstream's orchestrator cannot do this promptly, because the thing that would
// consume the message is a parked HTTP request that may be gone. A workflow is
// durable, so the moment Temporal has the signal the hold has done its job.
func (b *Bridge) ack(agentRunID string, seq int) {
	if err := b.publish(agentRunID, DownMessage{Type: DownReplyAck, AckSeq: &seq}); err != nil {
		// Not fatal: the agent re-offers, and the duplicate path above
		// re-acks. Worst case is one extra re-offer interval.
		log.Printf("[agent-bridge] %s: ack for seq %d failed; the agent will re-offer: %v", agentRunID, seq, err)
	}
}

// Prompt delivers a user turn (the initial goal or a follow-up) to a run.
func (b *Bridge) Prompt(agentRunID, message string) error {
	return b.publish(agentRunID, DownMessage{Type: DownPrompt, Message: message})
}

// Cancel asks a run to stop and exit.
func (b *Bridge) Cancel(agentRunID, reason string) error {
	return b.publish(agentRunID, DownMessage{Type: DownCancel, Reason: reason})
}

// ToolResult answers a sub-agent's tool_call (ADR 0028).
func (b *Bridge) ToolResult(agentRunID, callID string, ok bool, result string, errText string) error {
	msg := DownMessage{Type: DownToolResult, CallID: callID, OK: &ok, Error: errText}
	if ok {
		encoded, err := json.Marshal(result)
		if err != nil {
			return err
		}
		msg.Result = encoded
	}
	return b.publish(agentRunID, msg)
}

func (b *Bridge) publish(agentRunID string, msg DownMessage) error {
	b.mu.Lock()
	run, ok := b.runs[agentRunID]
	if !ok {
		b.mu.Unlock()
		return fmt.Errorf("agent run %s is not attached", agentRunID)
	}
	run.downSeq++
	msg.AgentRunID = agentRunID
	msg.Seq = run.downSeq
	msg.TS = time.Now().UTC().Format(time.RFC3339)
	subject := run.subjects.Down
	b.mu.Unlock()

	data, err := json.Marshal(msg)
	if err != nil {
		return fmt.Errorf("marshal %s: %w", msg.Type, err)
	}
	return b.conn.Publish(subject, data)
}

// --- the real NATS connection ---

type natsConn struct{ conn *nats.Conn }

// Dial opens a NATS connection with reconnection left to the client library.
//
// Deliberately not fatal on a dropped connection: an agent that publishes into
// a reconnect gap keeps holding its concluding message, so the run recovers
// once the subscription re-establishes. That property is upstream's ADR 0033
// mechanism, reused rather than reimplemented.
func Dial(url string) (Conn, func(), error) {
	conn, err := nats.Connect(url,
		nats.RetryOnFailedConnect(true),
		nats.MaxReconnects(-1),
		nats.DisconnectErrHandler(func(_ *nats.Conn, err error) {
			log.Printf("[agent-bridge] NATS disconnected (agents will hold their replies): %v", err)
		}),
		nats.ReconnectHandler(func(c *nats.Conn) {
			log.Printf("[agent-bridge] NATS reconnected to %s", c.ConnectedUrl())
		}),
	)
	if err != nil {
		return nil, nil, fmt.Errorf("connect to nats at %s: %w", url, err)
	}
	return &natsConn{conn: conn}, func() { conn.Close() }, nil
}

func (c *natsConn) Subscribe(subject string, handler func(data []byte)) (Subscription, error) {
	sub, err := c.conn.Subscribe(subject, func(m *nats.Msg) { handler(m.Data) })
	if err != nil {
		return nil, err
	}
	return sub, nil
}

func (c *natsConn) Publish(subject string, data []byte) error {
	if err := c.conn.Publish(subject, data); err != nil {
		return err
	}
	// Flush so a publish failure surfaces here rather than being discovered
	// when the agent never responds.
	return c.conn.FlushTimeout(5 * time.Second)
}
