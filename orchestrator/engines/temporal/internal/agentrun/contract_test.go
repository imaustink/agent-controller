package agentrun_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	protocolv1 "github.com/imaustink/agent-controller/framework/protocol/go/agentcontroller/protocol/v1"

	"github.com/controller-agent/temporal-engine/internal/agentrun"
	"github.com/controller-agent/temporal-engine/internal/messaging"
)

// The bridge speaks the canonical wire contract (framework/protocol, ADR 0047)
// in both directions. Each test here pins a behaviour the hand-written
// protocol got wrong before the contract existed.

// An agent may report fractional progress. UpMessage.Pct used to be an *int,
// so `42.5` made the whole message undecodable and it was dropped.
func TestAFractionalPctIsSignalled(t *testing.T) {
	_, conn, signaler, subjects := attached(t)
	conn.deliverRaw(t, subjects.Up,
		`{"agent_run_id":"`+runID+`","seq":1,"ts":"t","type":"progress","message":"cloning","pct":42.5}`)

	require.Equal(t, 1, signaler.count())
	require.NotNil(t, signaler.signals[0].Msg.Pct)
	require.InDelta(t, 42.5, *signaler.signals[0].Msg.Pct, 1e-9)
}

// The agent's own schema requires `message` on a prompt. DownMessage's
// omitempty tag used to drop it whenever the prompt was empty, so the agent
// rejected the turn.
func TestAnEmptyPromptStillCarriesMessage(t *testing.T) {
	bridge, conn, _, _ := attached(t)
	require.NoError(t, bridge.Prompt(runID, ""))

	sent := conn.sent()
	require.Len(t, sent, 1)
	var wire map[string]any
	require.NoError(t, json.Unmarshal(sent[0].Raw, &wire))
	require.Contains(t, wire, "message")
	require.Equal(t, "", wire["message"])
}

// Every down-message the bridge emits is a valid contract message, with the
// wire's own field spellings (`ackSeq`, `callId`), not proto's defaults.
func TestEveryDownMessageConformsToTheContract(t *testing.T) {
	bridge, conn, _, subjects := attached(t)
	require.NoError(t, bridge.Prompt(runID, "go"))
	require.NoError(t, bridge.Cancel(runID, ""))
	require.NoError(t, bridge.Cancel(runID, "user left"))
	require.NoError(t, bridge.ToolResult(runID, "c1", true, "42 results", ""))
	require.NoError(t, bridge.ToolResult(runID, "c2", false, "", "denied"))
	conn.deliverRaw(t, subjects.Up, `{"agent_run_id":"`+runID+`","seq":7,"ts":"t","type":"reply","message":"done","final":true}`)

	sent := conn.sent()
	require.Len(t, sent, 6)
	for _, m := range sent {
		require.NoError(t, messaging.CheckContract(m.Raw, &protocolv1.AgentDownMessage{}), "%s: %s", m.Down.Type, m.Raw)
	}
	require.Contains(t, string(sent[3].Raw), `"callId"`)
	require.Contains(t, string(sent[5].Raw), `"ackSeq"`)
	require.Equal(t, []int{7}, conn.acks())
}

// A message the contract rejects is dropped before it reaches the workflow --
// and, being dropped, is never acked, so a real agent keeps re-offering it
// rather than believing it was delivered.
func TestAnUpMessageViolatingTheContractIsDroppedAndNotAcked(t *testing.T) {
	_, conn, signaler, subjects := attached(t)
	conn.deliverRaw(t, subjects.Up, `{"agent_run_id":"`+runID+`","seq":1,"ts":"t","type":"reply","message":"no final flag"}`)
	conn.deliverRaw(t, subjects.Up, `{"agent_run_id":"`+runID+`","seq":2,"ts":"t","type":"ask","message":"unknown type"}`)

	require.Zero(t, signaler.count())
	require.Empty(t, conn.acks())
}

// The struct still encodes a non-final reply with `final` present.
func TestANonFinalReplyStructEncodesFinal(t *testing.T) {
	raw, err := json.Marshal(agentrun.UpMessage{AgentRunID: runID, Seq: 1, TS: "t", Type: agentrun.UpReply, Message: "which branch?"})
	require.NoError(t, err)
	require.NoError(t, messaging.CheckContract(raw, &protocolv1.AgentUpMessage{}))
}
