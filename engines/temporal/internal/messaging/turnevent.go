package messaging

import "fmt"

// --- B1 spike (ADR 0004): unified lifecycle event envelope -------------------
//
// Today the user-facing stream is a []string of free-text narration
// (workflows.TurnProgress), while the tool stream is the typed Event above. A
// tool's rich typed event is flattened to a single string at the bridge in
// agentloop.go (OnProgress: note(stage + ": " + message)), discarding Stage,
// Pct, Artifacts and the event Type.
//
// TurnEvent is one typed envelope spanning the whole turn lifecycle. It extends
// the tool-level kinds (accepted/progress/… above) with turn-level kinds, so a
// single schema carries everything the client might observe. Render() produces
// the exact legacy narration string for each kind, so the gateway can keep
// emitting []string to OpenAI clients unchanged (down-convert at the edge) while
// the core stops throwing structure away.
//
// This spike adds only the type + constructors + render; wiring note() and the
// gateway to it is the rest of B1 (see ADR 0004 milestones).

// Turn-level lifecycle kinds, alongside the tool-level Event* kinds above.
const (
	KindTurnStarted   = "turn-started"
	KindSkillSelected = "skill-selected"
	KindToolStarted   = "tool-started"
	KindToolProgress  = "tool-progress"
	KindToolFinished  = "tool-finished"
	KindToolFailed    = "tool-failed"
	KindWarning       = "warning"
	KindTurnCompleted = "turn-completed"

	// KindApprovalRequired / KindApprovalResolved carry the tool-approval HITL
	// (ADR 0003) as first-class lifecycle events rather than bare narration, so a
	// client can render an approve/deny affordance instead of parsing a string.
	KindApprovalRequired = "approval-required"
	KindApprovalResolved = "approval-resolved"

	// KindNarration is the catch-all for a free-text status line that has no
	// richer structure yet. It lets every note() call site flow through the one
	// typed envelope while the specific kinds above are adopted incrementally.
	KindNarration = "narration"
)

// TurnEvent is the unified, replayable lifecycle envelope. Structured fields are
// kept rather than pre-rendered into Message, so a client (or a future durable
// offset log, ADR 0004 B2) can consume structure; Render() is only the
// backward-compatible string projection.
type TurnEvent struct {
	Seq  int    `json:"seq"`
	TS   string `json:"ts"`
	Kind string `json:"kind"`

	// Structured context, preserved instead of flattened into a string.
	SkillID   string        `json:"skill_id,omitempty"`
	ToolID    string        `json:"tool_id,omitempty"`
	Stage     string        `json:"stage,omitempty"`
	Pct       *float64      `json:"pct,omitempty"`
	Code      string        `json:"code,omitempty"`
	Artifacts []ArtifactRef `json:"artifacts,omitempty"`

	// Message is free-text for kinds that are inherently narration (warning,
	// and the raw tool-progress message).
	Message string `json:"message,omitempty"`
}

// SkillSelected mirrors note("Using skill " + id) (agentloop.go:301).
func SkillSelected(seq int, ts, skillID string) TurnEvent {
	return TurnEvent{Seq: seq, TS: ts, Kind: KindSkillSelected, SkillID: skillID}
}

// ToolStarted mirrors note("Running " + id + "…") (agentloop.go:684).
func ToolStarted(seq int, ts, toolID string) TurnEvent {
	return TurnEvent{Seq: seq, TS: ts, Kind: KindToolStarted, ToolID: toolID}
}

// ToolFinished mirrors note(id + " finished") (agentloop.go:708 et al).
func ToolFinished(seq int, ts, toolID string) TurnEvent {
	return TurnEvent{Seq: seq, TS: ts, Kind: KindToolFinished, ToolID: toolID}
}

// ToolFailed mirrors note(id + " failed: " + code) (agentloop.go:711).
func ToolFailed(seq int, ts, toolID, code string) TurnEvent {
	return TurnEvent{Seq: seq, TS: ts, Kind: KindToolFailed, ToolID: toolID, Code: code}
}

// Narration wraps a plain status line (every note() call site) in the envelope.
func Narration(seq int, ts, line string) TurnEvent {
	return TurnEvent{Seq: seq, TS: ts, Kind: KindNarration, Message: line}
}

// ApprovalRequired marks a tool call paused for human approval (ADR 0003).
func ApprovalRequired(seq int, ts, toolID, prompt string) TurnEvent {
	return TurnEvent{Seq: seq, TS: ts, Kind: KindApprovalRequired, ToolID: toolID, Message: prompt}
}

// ApprovalResolved marks an approval decision; approved reports the outcome.
func ApprovalResolved(seq int, ts, toolID string, approved bool) TurnEvent {
	msg := "denied"
	if approved {
		msg = "approved"
	}
	return TurnEvent{Seq: seq, TS: ts, Kind: KindApprovalResolved, ToolID: toolID, Message: msg}
}

// FromToolEvent lifts a typed tool-stream Event (progress/warning) into a
// TurnEvent, preserving Stage/Pct/Artifacts — the structure the current
// OnProgress bridge (agentloop.go:833-839) discards.
func FromToolEvent(seq int, e Event) TurnEvent {
	kind := KindToolProgress
	if e.Type == EventWarning {
		kind = KindWarning
	}
	return TurnEvent{
		Seq:       seq,
		TS:        e.TS,
		Kind:      kind,
		ToolID:    e.JobID,
		Stage:     e.Stage,
		Pct:       e.Pct,
		Artifacts: e.Artifacts,
		Message:   e.Message,
	}
}

// Render is the backward-compatible []string projection: it reproduces exactly
// the narration line today's note() call sites emit, so the gateway's
// down-convert is a drop-in.
func (t TurnEvent) Render() string {
	switch t.Kind {
	case KindSkillSelected:
		return "Using skill " + t.SkillID
	case KindToolStarted:
		return "Running " + t.ToolID + "…"
	case KindToolFinished:
		return t.ToolID + " finished"
	case KindToolFailed:
		return t.ToolID + " failed: " + t.Code
	case KindToolProgress, KindWarning:
		// Matches the current bridge: stage-prefixed when a stage is present.
		if t.Stage != "" {
			return t.Stage + ": " + t.Message
		}
		return t.Message
	case KindApprovalRequired:
		// The prompt text is already the human-facing line.
		return t.Message
	case KindNarration:
		return t.Message
	default:
		return t.Message
	}
}

// String aids debugging/logging; not the client projection (that is Render).
func (t TurnEvent) String() string {
	return fmt.Sprintf("TurnEvent{seq=%d kind=%s tool=%s skill=%s}", t.Seq, t.Kind, t.ToolID, t.SkillID)
}
