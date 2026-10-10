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

// Every up-message type, built the way the agent SDK and opencode-swe-agent
// build it, passes the gate and reaches the workflow -- so the gate can only
// ever drop a message no real agent sends. Concluding types are also acked.
func TestEveryValidUpMessageTypePassesTheGate(t *testing.T) {
	cases := map[string]struct {
		body       string
		concluding bool
	}{
		"ready":             {body: `"type":"ready"`},
		"progress":          {body: `"type":"progress","message":"cloning","stage":"setup","pct":12.5`},
		"progress (bare)":   {body: `"type":"progress","message":"Starting opencode…"`},
		"warning":           {body: `"type":"warning","message":"flaky test"`},
		"reply (question)":  {body: `"type":"reply","message":"Which branch?","final":false`, concluding: true},
		"reply (final)":     {body: `"type":"reply","message":"done","final":true,"result":{"pr":12}`, concluding: true},
		"failed":            {body: `"type":"failed","code":"agent_error","message":"boom"`, concluding: true},
		"tool_call":         {body: `"type":"tool_call","callId":"c1","tool":"web-search","input":"{\"q\":\"x\"}"`},
		"opencode_event":    {body: `"type":"opencode_event","event":{"type":"message.part"}`},
		"opencode_response": {body: `"type":"opencode_response","requestId":"q1","status":503,"body":{"error":"not ready"}`},
		"session_idle":      {body: `"type":"session_idle","liveUntil":"2026-10-10T01:00:00Z"`},
		"session_ended":     {body: `"type":"session_ended","reason":"idle timeout"`},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, conn, signaler, subjects := attached(t)
			conn.deliverRaw(t, subjects.Up, `{"agent_run_id":"`+runID+`","seq":3,"ts":"t",`+c.body+`}`)
			require.Equal(t, 1, signaler.count(), "a valid %s must be signalled", name)
			if c.concluding {
				require.Equal(t, []int{3}, conn.acks())
			} else {
				require.Empty(t, conn.acks(), "narration is never acked")
			}
		})
	}
}

// The struct still encodes a non-final reply with `final` present.
func TestANonFinalReplyStructEncodesFinal(t *testing.T) {
	raw, err := json.Marshal(agentrun.UpMessage{AgentRunID: runID, Seq: 1, TS: "t", Type: agentrun.UpReply, Message: "which branch?"})
	require.NoError(t, err)
	require.NoError(t, messaging.CheckContract(raw, &protocolv1.AgentUpMessage{}))
}
