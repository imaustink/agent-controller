package messaging

import "encoding/json"

// Pod-agent step envelope: a checkpoint-resume agent (e.g. opencode) runs
// each work step as a one-shot Job and reports through the ordinary tool
// event stream, with its `succeeded` result carrying this envelope. The Job
// then EXITS — the wrapping PodAgentWorkflow does all waiting. This
// replaces agent-controller's session.ask()-over-NATS, where the pod idled
// alive while a human thought.
const (
	StepQuestion = "question" // needs a human answer before the next step
	StepFinal    = "final"    // episode complete; Message is the answer
)

type AgentStepResult struct {
	Status  string `json:"status"`
	Message string `json:"message"`
	// Continuation is the agent's opaque resume state (repo/branch/PR,
	// session id, …), re-injected into the next step's input as a leading
	// `<!-- continuation: … -->` marker. Never parsed here, never shown to
	// the transcript.
	Continuation string `json:"continuation,omitempty"`
}

// ParseAgentStepResult decodes a step Job's result. A plain string result
// (a regular tool pressed into agent service) degrades to a final answer.
func ParseAgentStepResult(raw json.RawMessage) AgentStepResult {
	var envelope AgentStepResult
	if err := json.Unmarshal(raw, &envelope); err == nil && (envelope.Status == StepQuestion || envelope.Status == StepFinal) {
		return envelope
	}
	var text string
	if err := json.Unmarshal(raw, &text); err == nil {
		return AgentStepResult{Status: StepFinal, Message: text}
	}
	return AgentStepResult{Status: StepFinal, Message: string(raw)}
}
