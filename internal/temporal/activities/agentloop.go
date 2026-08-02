package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"durable-agents/internal/catalog"
	"durable-agents/internal/llm"
)

// Activity names for the agent loop's LLM decision nodes — ports of
// agent-controller's capability-need-checker, skill-fit-checker,
// skill-selector, action-planner, and response-composer.
const (
	CheckNeedsCapabilityActivityName = "CheckNeedsCapability"
	CheckSkillFitActivityName        = "CheckSkillFit"
	SelectSkillActivityName          = "SelectSkill"
	PlanActionActivityName           = "PlanAction"
	ComposeResponseActivityName      = "ComposeResponse"
)

// LLM is the slice of *llm.Client these activities need; tests fake it.
type LLM interface {
	Complete(ctx context.Context, messages []llm.Message) (string, error)
	CompleteJSON(ctx context.Context, messages []llm.Message, schema llm.ResponseSchema) (json.RawMessage, error)
}

type AgentLoopActivities struct {
	LLM LLM
}

const (
	// maxPromptResult bounds tool results folded into planner prompts.
	maxPromptResult = 4000
	// maxPromptMarkdown bounds skill markdown in cheap check prompts.
	maxPromptMarkdown = 500
)

// --- capability gate (ADR 0019) ---

var needsCapabilitySchema = llm.ResponseSchema{
	Name: "needs_capability",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {"needs_capability": {"type": "boolean"}},
		"required": ["needs_capability"],
		"additionalProperties": false
	}`),
}

// CheckNeedsCapability decides whether a turn needs the catalog at all.
// Ambiguity defaults to true (the opposite of the fit checkers): wrongly
// skipping retrieval breaks real requests, wrongly running it just costs a
// query.
func (a *AgentLoopActivities) CheckNeedsCapability(ctx context.Context, request string) (bool, error) {
	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: "You route requests for an agent platform. Decide whether the user's message needs external capabilities — running tools, taking actions, fetching or transforming external data — or is purely conversational (greetings, opinions, questions answerable from general knowledge). When uncertain, answer that capabilities ARE needed."},
		{Role: "user", Content: request},
	}, needsCapabilitySchema)
	if err != nil {
		return false, err
	}
	var out struct {
		NeedsCapability bool `json:"needs_capability"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return true, nil // ambiguity → capability path
	}
	return out.NeedsCapability, nil
}

// --- session-continuity fit check (ADR 0012) ---

var skillFitSchema = llm.ResponseSchema{
	Name: "skill_fit",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {"fits": {"type": "boolean"}},
		"required": ["fits"],
		"additionalProperties": false
	}`),
}

type CheckSkillFitInput struct {
	Request string                  `json:"request"`
	Skill   catalog.SkillDescriptor `json:"skill"`
}

// CheckSkillFit re-evaluates a conversation's active skill for a new turn.
// A miss is never an error — ambiguity defaults to false so the turn falls
// back to full retrieval.
func (a *AgentLoopActivities) CheckSkillFit(ctx context.Context, in CheckSkillFitInput) (bool, error) {
	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: "A conversation has an active skill. Decide whether the user's new message still belongs to that skill's workflow, or pivots to something else. Answer fits=false when in doubt."},
		{Role: "user", Content: fmt.Sprintf(
			"Active skill %q: %s\n\nSkill instructions (excerpt):\n%s\n\nNew message:\n%s",
			in.Skill.ID, in.Skill.Description, truncate(in.Skill.Markdown, maxPromptMarkdown), in.Request)},
	}, skillFitSchema)
	if err != nil {
		return false, err
	}
	var out struct {
		Fits bool `json:"fits"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return false, nil
	}
	return out.Fits, nil
}

// --- skill selection (ADR 0008) ---

var selectSkillSchema = llm.ResponseSchema{
	Name: "select_skill",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {"skill_id": {"type": "string"}},
		"required": ["skill_id"],
		"additionalProperties": false
	}`),
}

type SelectSkillInput struct {
	Request    string                    `json:"request"`
	Candidates []catalog.SkillDescriptor `json:"candidates"`
}

// SelectSkill picks one retrieved skill or none (""). The returned id is
// validated against the candidate set — a hallucinated id becomes "no match".
func (a *AgentLoopActivities) SelectSkill(ctx context.Context, in SelectSkillInput) (string, error) {
	var list strings.Builder
	for _, s := range in.Candidates {
		fmt.Fprintf(&list, "- id: %s\n  description: %s\n", s.ID, s.Description)
	}
	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: "Select the single skill whose purpose genuinely covers the user's request, or the empty string if none does. Superficial word overlap between the request and a skill description is not a match."},
		{Role: "user", Content: fmt.Sprintf("Request:\n%s\n\nCandidate skills:\n%s\nAnswer with one candidate id or \"\".", in.Request, list.String())},
	}, selectSkillSchema)
	if err != nil {
		return "", err
	}
	var out struct {
		SkillID string `json:"skill_id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", nil
	}
	for _, s := range in.Candidates {
		if s.ID == out.SkillID {
			return out.SkillID, nil
		}
	}
	return "", nil
}

// --- action planning (ADR 0008) ---

const (
	ActionRespond  = "respond"
	ActionCallTool = "call_tool"
	ActionFinish   = "finish"
)

var planActionSchema = llm.ResponseSchema{
	Name: "plan_action",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"action": {"type": "string", "enum": ["respond", "call_tool", "finish"]},
			"tool_id": {"type": "string"},
			"tool_input": {"type": "string"},
			"response": {"type": "string"}
		},
		"required": ["action", "tool_id", "tool_input", "response"],
		"additionalProperties": false
	}`),
}

type PlannedAction struct {
	Action    string `json:"action"`
	ToolID    string `json:"tool_id"`
	ToolInput string `json:"tool_input"`
	Response  string `json:"response"`
}

// ActionRecord is one completed step fed back to the planner.
type ActionRecord struct {
	ToolID    string `json:"toolId"`
	Input     string `json:"input"`
	Succeeded bool   `json:"succeeded"`
	Result    string `json:"result,omitempty"`
	Error     string `json:"error,omitempty"`
}

type PlanActionInput struct {
	Request       string                   `json:"request"`
	SkillMarkdown string                   `json:"skillMarkdown"`
	Tools         []catalog.ToolDescriptor `json:"tools"`
	History       []ActionRecord           `json:"history,omitempty"`
}

// PlanAction decides the next step of a skill-driven turn. The skill's
// markdown (trusted, catalog-authored) is the system prompt; tools are
// presented as data. The workflow re-validates the chosen tool id.
func (a *AgentLoopActivities) PlanAction(ctx context.Context, in PlanActionInput) (PlannedAction, error) {
	system := in.SkillMarkdown + "\n\n---\n" +
		"You are the action planner executing the workflow above. Decide the next step:\n" +
		"- respond: answer the user directly now; put the complete answer in `response`.\n" +
		"- call_tool: run one of the available tools; set `tool_id` and `tool_input`.\n" +
		"- finish: the latest successful tool result is the answer; it will be shown to the user as-is.\n" +
		"Only ever use a tool id from the available tools list. If a previous step failed, either retry with different input or respond explaining the problem. Leave unused fields as empty strings."

	var user strings.Builder
	fmt.Fprintf(&user, "User request:\n%s\n\nAvailable tools:\n", in.Request)
	for _, t := range in.Tools {
		fmt.Fprintf(&user, "- id: %s\n  description: %s\n", t.ID, t.Description)
		if t.Input != "" {
			fmt.Fprintf(&user, "  input: %s\n", t.Input)
		}
	}
	if len(in.History) > 0 {
		user.WriteString("\nSteps taken this turn:\n")
		for _, h := range in.History {
			if h.Succeeded {
				fmt.Fprintf(&user, "- %s(%s) succeeded: %s\n", h.ToolID, h.Input, truncate(h.Result, maxPromptResult))
			} else {
				fmt.Fprintf(&user, "- %s(%s) FAILED: %s\n", h.ToolID, h.Input, h.Error)
			}
		}
	}

	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: system},
		{Role: "user", Content: user.String()},
	}, planActionSchema)
	if err != nil {
		return PlannedAction{}, err
	}
	var plan PlannedAction
	if err := json.Unmarshal(raw, &plan); err != nil {
		return PlannedAction{}, fmt.Errorf("decode planned action: %w", err)
	}
	switch plan.Action {
	case ActionRespond, ActionCallTool, ActionFinish:
	default:
		return PlannedAction{}, fmt.Errorf("planner returned unknown action %q", plan.Action)
	}
	return plan, nil
}

// --- response composition (ADR 0015) ---

var composeResponseSchema = llm.ResponseSchema{
	Name: "compose_response",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"prefix": {"type": "string"},
			"suffix": {"type": "string"}
		},
		"required": ["prefix", "suffix"],
		"additionalProperties": false
	}`),
}

type ComposeResponseInput struct {
	Request       string `json:"request"`
	SkillMarkdown string `json:"skillMarkdown"`
	Result        string `json:"result"`
}

type ComposedResponse struct {
	Prefix string `json:"prefix"`
	Suffix string `json:"suffix"`
}

// ComposeResponse asks the skill how to frame a verbatim tool result: an
// additive prefix/suffix only, never a rewrite.
func (a *AgentLoopActivities) ComposeResponse(ctx context.Context, in ComposeResponseInput) (ComposedResponse, error) {
	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: in.SkillMarkdown + "\n\n---\nThe tool result below will be shown to the user verbatim. Provide only a short optional prefix and suffix (empty strings are fine) framing it per the workflow above. Never restate, summarize, or modify the result itself."},
		{Role: "user", Content: fmt.Sprintf("User request:\n%s\n\nTool result (shown verbatim):\n%s", in.Request, truncate(in.Result, maxPromptResult))},
	}, composeResponseSchema)
	if err != nil {
		return ComposedResponse{}, err
	}
	var out ComposedResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return ComposedResponse{}, nil // framing is optional; never block the reply
	}
	return out, nil
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n…(truncated)"
}
