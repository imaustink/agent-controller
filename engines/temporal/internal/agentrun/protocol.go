// Package agentrun bridges agent-controller's pod agents into Temporal
// workflows.
//
// # Why this exists at all
//
// ADR 0001 §6 dropped NATS: the bidirectional agent channel becomes workflow
// signals. That reasoning still holds for agents we write. It does not hold for
// the ones already running: since that ADR, upstream built the live opencode
// tunnel (ADR 0026), sub-agent tool calls (ADR 0028) and the reply-ack hold
// (ADR 0033) on this channel, and `claude-code-swe-agent` — which speaks it —
// became the production triage agent. Requiring it to be rewritten as a
// precondition for merging would be the wrong trade.
//
// So a Temporal workflow can also drive an unmodified AgentRun: this package
// speaks the protocol, and a worker-side bridge translates it into signals.
// Checkpoint-resume (docs/pod-agents.md) remains available for new agents.
//
// # What Temporal changes about the protocol
//
// One thing, and it is the clearest single demonstration of the thesis.
//
// ADR 0033 exists because an agent turn's work lives in a Job pod while the
// turn's WAIT lives in an orchestrator pod, and the second lifetime is far
// shorter — eleven rollouts in fourteen hours, in the incident that prompted
// it. Core NATS has no durability, so a `reply` published while no orchestrator
// is subscribed is discarded outright. The fix was to make the agent HOLD its
// concluding message, re-offering it every 10s until acked, using the pod that
// outlives the orchestrator as the buffer.
//
// Here the wait is a workflow, and a workflow does not disappear. The buffer has
// nothing to buffer against, so the bridge acks on receipt — which ADR 0033
// itself names as the exit condition ("AGENT_REPLY_ACK_TIMEOUT_MS=0 is the
// switch that retires it").
//
// The caveat, which is real and is handled rather than assumed away: the BRIDGE
// is not the workflow. A crash between "NATS delivered the reply" and "Temporal
// accepted the signal" would still lose it. So the ack is sent only AFTER the
// signal is accepted, and re-offers are idempotent by `seq` — which ADR 0033
// deliberately guarantees, precisely so a consumer can tell a re-offer from a
// second reply.
package agentrun

import (
	"encoding/json"
	"fmt"
)

// Up-message types (agent → orchestrator).
const (
	UpReady            = "ready"
	UpProgress         = "progress"
	UpWarning          = "warning"
	UpReply            = "reply"
	UpFailed           = "failed"
	UpToolCall         = "tool_call"
	UpOpencodeEvent    = "opencode_event"
	UpOpencodeResponse = "opencode_response"
	UpSessionIdle      = "session_idle"
	UpSessionEnded     = "session_ended"
)

// Down-message types (orchestrator → agent).
const (
	DownPrompt          = "prompt"
	DownCancel          = "cancel"
	DownSignal          = "signal"
	DownReplyAck        = "reply_ack"
	DownToolResult      = "tool_result"
	DownOpencodeRequest = "opencode_request"
)

// UpMessage is one agent → orchestrator message. A superset of every variant;
// Type says which fields are meaningful.
type UpMessage struct {
	AgentRunID string `json:"agent_run_id"`
	Seq        int    `json:"seq"`
	TS         string `json:"ts"`
	Type       string `json:"type"`

	// progress / warning / reply / failed
	Stage   string `json:"stage,omitempty"`
	Message string `json:"message,omitempty"`
	Pct     *int   `json:"pct,omitempty"`
	Code    string `json:"code,omitempty"`

	// reply. Final=false means the agent awaits a further prompt — including
	// the case where Message is a question for the user. HITL is expressed
	// without a dedicated ask/answer pair, because a human may take
	// arbitrarily long and answer across chat turns, so no reply timeout can
	// apply.
	Final  bool            `json:"final,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`

	// tool_call
	CallID string `json:"callId,omitempty"`
	Tool   string `json:"tool,omitempty"`
	Input  string `json:"input,omitempty"`
}

// IsConcluding reports whether this message carries the turn's whole outcome,
// and therefore whether losing it would turn a run that succeeded into a turn
// that visibly failed. These are the messages the agent holds until acked.
func (m UpMessage) IsConcluding() bool {
	return m.Type == UpReply || m.Type == UpFailed
}

// ResultText renders a reply's optional structured result as text.
func (m UpMessage) ResultText() string {
	if len(m.Result) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(m.Result, &asString); err == nil {
		return asString
	}
	return string(m.Result)
}

// DownMessage is one orchestrator → agent message.
type DownMessage struct {
	AgentRunID string `json:"agent_run_id"`
	Seq        int    `json:"seq"`
	TS         string `json:"ts"`
	Type       string `json:"type"`

	Message string `json:"message,omitempty"` // prompt
	Reason  string `json:"reason,omitempty"`  // cancel
	Name    string `json:"name,omitempty"`    // signal
	AckSeq  *int   `json:"ackSeq,omitempty"`  // reply_ack

	// tool_result
	CallID string          `json:"callId,omitempty"`
	OK     *bool           `json:"ok,omitempty"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

// Subjects are the two NATS subjects for one agent run.
//
// Deterministic and keyed by the AgentRun id, which is the whole reason a queue
// beats a direct socket: a follow-up turn reaches the exact running agent
// regardless of which process launched it — or, here, regardless of which
// worker replica happens to be bridging.
type Subjects struct {
	Up   string // agent publishes, we subscribe
	Down string // we publish, agent subscribes
}

// SubjectsFor mirrors upstream's agentSubjects exactly. Diverging would make
// an unmodified agent unreachable, which is the entire point of this package.
func SubjectsFor(agentRunID, prefix string) Subjects {
	if prefix == "" {
		prefix = "agent"
	}
	return Subjects{
		Up:   fmt.Sprintf("%s.%s.up", prefix, agentRunID),
		Down: fmt.Sprintf("%s.%s.down", prefix, agentRunID),
	}
}
