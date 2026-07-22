package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"durable-agents/internal/catalog"
	"durable-agents/internal/llm"
)

const (
	SelectDelegateActivityName  = "SelectDelegate"
	PlanAgentActionActivityName = "PlanAgentAction"
)

// --- delegate selection (skill vs agent, ADR 0021's DelegateSelector) ---

const (
	DelegateSkill = "skill"
	DelegateAgent = "agent"
	DelegateNone  = ""
)

var selectDelegateSchema = llm.ResponseSchema{
	Name: "select_delegate",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"kind": {"type": "string", "enum": ["skill", "agent", "none"]},
			"id": {"type": "string"}
		},
		"required": ["kind", "id"],
		"additionalProperties": false
	}`),
}

type SelectDelegateInput struct {
	Request string                    `json:"request"`
	Skills  []catalog.SkillDescriptor `json:"skills"`
	Agents  []catalog.AgentDescriptor `json:"agents"`
}

type DelegateChoice struct {
	Kind string `json:"kind"` // skill | agent | ""
	ID   string `json:"id"`
}

// SelectDelegate picks one skill OR one agent (or none) from the retrieved
// candidates. Hallucinated ids fail to "none", like SelectSkill.
func (a *AgentLoopActivities) SelectDelegate(ctx context.Context, in SelectDelegateInput) (DelegateChoice, error) {
	var list strings.Builder
	for _, s := range in.Skills {
		fmt.Fprintf(&list, "- kind: skill, id: %s\n  description: %s\n", s.ID, s.Description)
	}
	for _, ag := range in.Agents {
		fmt.Fprintf(&list, "- kind: agent, id: %s\n  description: %s\n", ag.ID, ag.Description)
		if ag.OrchestratorPrompt != "" {
			fmt.Fprintf(&list, "  when to delegate: %s\n", ag.OrchestratorPrompt)
		}
	}

	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: "Select the single skill or agent whose purpose genuinely covers the user's request, or kind \"none\" if nothing does. A skill is a guided workflow the assistant runs itself; an agent is an autonomous delegate for open-ended, multi-step work. Superficial word overlap is not a match."},
		{Role: "user", Content: fmt.Sprintf("Request:\n%s\n\nCandidates:\n%s", in.Request, list.String())},
	}, selectDelegateSchema)
	if err != nil {
		return DelegateChoice{}, err
	}
	var out struct {
		Kind string `json:"kind"`
		ID   string `json:"id"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return DelegateChoice{}, nil
	}
	switch out.Kind {
	case DelegateSkill:
		for _, s := range in.Skills {
			if s.ID == out.ID {
				return DelegateChoice{Kind: DelegateSkill, ID: out.ID}, nil
			}
		}
	case DelegateAgent:
		for _, ag := range in.Agents {
			if ag.ID == out.ID {
				return DelegateChoice{Kind: DelegateAgent, ID: out.ID}, nil
			}
		}
	}
	return DelegateChoice{}, nil
}

// --- agent-episode planning (the child workflow's decision node) ---

const (
	AgentActionCallTool = "call_tool"
	AgentActionAskUser  = "ask_user"
	AgentActionDelegate = "delegate"
	AgentActionFinish   = "finish"
)

var planAgentActionSchema = llm.ResponseSchema{
	Name: "plan_agent_action",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"action": {"type": "string", "enum": ["call_tool", "ask_user", "delegate", "finish"]},
			"tool_id": {"type": "string"},
			"tool_input": {"type": "string"},
			"question": {"type": "string"},
			"agent_id": {"type": "string"},
			"goal": {"type": "string"},
			"message": {"type": "string"}
		},
		"required": ["action", "tool_id", "tool_input", "question", "agent_id", "goal", "message"],
		"additionalProperties": false
	}`),
}

type PlannedAgentAction struct {
	Action    string `json:"action"`
	ToolID    string `json:"tool_id"`
	ToolInput string `json:"tool_input"`
	Question  string `json:"question"`
	AgentID   string `json:"agent_id"`
	Goal      string `json:"goal"`
	Message   string `json:"message"`
}

type PlanAgentActionInput struct {
	Goal        string                    `json:"goal"`
	AgentPrompt string                    `json:"agentPrompt"`
	Tools       []catalog.ToolDescriptor  `json:"tools"`
	Agents      []catalog.AgentDescriptor `json:"agents,omitempty"` // delegable (empty at the depth cap)
	History     []ActionRecord            `json:"history,omitempty"`
}

// PlanAgentAction is the sub-agent's decision node: work a tool, ask the
// human a question (the workflow waits durably — no pod idles on this),
// delegate a sub-goal to another agent, or finish with the final message.
func (a *AgentLoopActivities) PlanAgentAction(ctx context.Context, in PlanAgentActionInput) (PlannedAgentAction, error) {
	system := in.AgentPrompt + "\n\n---\n" +
		"You are an autonomous agent working toward the goal below. Decide the next step:\n" +
		"- call_tool: run one of the available tools (`tool_id`, `tool_input`).\n" +
		"- ask_user: you need information only the user has; put the question in `question`.\n" +
		"- delegate: hand a sub-goal to one of the delegable agents (`agent_id`, `goal`).\n" +
		"- finish: the goal is done (or cannot proceed); put the final answer in `message`.\n" +
		"Only use listed tool/agent ids. Leave unused fields as empty strings."

	var user strings.Builder
	fmt.Fprintf(&user, "Goal:\n%s\n", in.Goal)
	if len(in.Tools) > 0 {
		user.WriteString("\nAvailable tools:\n")
		for _, t := range in.Tools {
			fmt.Fprintf(&user, "- id: %s\n  description: %s\n", t.ID, t.Description)
		}
	}
	if len(in.Agents) > 0 {
		user.WriteString("\nDelegable agents:\n")
		for _, ag := range in.Agents {
			fmt.Fprintf(&user, "- id: %s\n  description: %s\n", ag.ID, ag.Description)
		}
	}
	if len(in.History) > 0 {
		user.WriteString("\nSteps taken:\n")
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
	}, planAgentActionSchema)
	if err != nil {
		return PlannedAgentAction{}, err
	}
	var plan PlannedAgentAction
	if err := json.Unmarshal(raw, &plan); err != nil {
		return PlannedAgentAction{}, fmt.Errorf("decode planned agent action: %w", err)
	}
	switch plan.Action {
	case AgentActionCallTool, AgentActionAskUser, AgentActionDelegate, AgentActionFinish:
	default:
		return PlannedAgentAction{}, fmt.Errorf("agent planner returned unknown action %q", plan.Action)
	}
	return plan, nil
}
