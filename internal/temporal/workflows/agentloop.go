package workflows

import (
	"fmt"

	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/catalog"
	"durable-agents/internal/continuation"
	"durable-agents/internal/messaging"
	"durable-agents/internal/temporal/activities"
)

// maxToolSteps bounds the plan⇄runTool loop per turn (upstream MAX_TOOL_STEPS).
const maxToolSteps = 4

// TurnMeta reports what the agent loop did, for TurnResult/debugging.
type TurnMeta struct {
	// Path is how this turn reached its target:
	//   bare             — no capability needed, or nothing matched
	//   skill            — selected by retrieval
	//   skill-continued  — the conversation's active skill still fits
	//   skill-routed     — named by an IntegrationRoute (ADR 0024)
	//   agent            — selected by retrieval
	//   agent-continued  — an episode already in flight took the turn
	//   agent-routed     — named by an IntegrationRoute (ADR 0024)
	Path      string   `json:"path"`
	SkillID   string   `json:"skillId,omitempty"` // active skill after this turn
	AgentID   string   `json:"agentId,omitempty"` // agent handling this turn
	ToolCalls []string `json:"toolCalls,omitempty"`
	// Narration is the turn's full progress transcript — the authoritative
	// version of what TurnProgressQuery exposed while the turn ran.
	Narration []string `json:"narration,omitempty"`
}

// runAgentTurn is the ported agent loop: active agent → integration route →
// active-skill fit check → capability gate → retrieve → select → resolve
// tools → plan⇄runTool → compose. It returns the reply plus which skill (if
// any) stays active. Mirrors agent-controller's graph nodes.
func runAgentTurn(ctx workflow.Context, actx workflow.Context, state *ConversationState, in TurnInput, note func(string)) (string, TurnMeta, error) {
	logger := workflow.GetLogger(ctx)
	meta := TurnMeta{Path: "bare"}
	if note == nil {
		note = func(string) {}
	}

	// 0. Mid-episode agent takes the turn outright (upstream's
	// checkActiveAgentRun): forward the message as the HITL answer.
	if state.ActiveAgentWorkflowID != "" {
		note("Continuing with agent " + state.ActiveAgentID)
		err := workflow.SignalExternalWorkflow(ctx, state.ActiveAgentWorkflowID, "", AgentPromptSignal, AgentPrompt{Message: in.Message}).Get(ctx, nil)
		if err == nil {
			meta.Path = "agent-continued"
			meta.AgentID = state.ActiveAgentID
			reply := handleAgentUp(ctx, state, state.ActiveAgentID, state.ActiveAgentWorkflowID, note)
			return reply, meta, nil
		}
		// Child gone (terminated or already closed) — clear and fall through.
		logger.Warn("active agent unreachable; falling back", "workflowId", state.ActiveAgentWorkflowID, "error", err)
		state.ActiveAgentID, state.ActiveAgentWorkflowID = "", ""
	}

	var skillTools *activities.SkillTools

	// 0.5. Deterministic dispatch (ADR 0024). The gateway matched this turn's
	// event descriptor to an IntegrationRoute and named a target; re-resolve
	// it under the caller's CURRENT roles and go straight there, skipping
	// retrieval. Deliberately AFTER the active-agent check above: a re-applied
	// trigger label on an issue an agent is already working would otherwise
	// start the work a second time — a second branch and a second PR on a real
	// coding agent. A miss falls through, never an error.
	if in.Caller.Subject != "" {
		if in.ForcedAgentID != "" {
			var agent *catalog.AgentDescriptor
			if err := workflow.ExecuteActivity(actx, activities.ResolveAgentActivityName, activities.ResolveAgentInput{
				Caller:  in.Caller,
				AgentID: in.ForcedAgentID,
			}).Get(ctx, &agent); err != nil {
				logger.Warn("forced agent lookup failed; falling through to retrieval", "agentId", in.ForcedAgentID, "error", err)
			} else if agent != nil {
				note("Routing to agent " + agent.ID)
				reply, m, err := delegateToAgent(ctx, state, in, *agent, &meta, note)
				m.Path = "agent-routed"
				return reply, m, err
			} else {
				logger.Info("forced agent not visible to caller; falling through", "agentId", in.ForcedAgentID)
			}
		}
		if in.ForcedSkillID != "" {
			var resolved *activities.SkillTools
			if err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
				Caller:  in.Caller,
				SkillID: in.ForcedSkillID,
			}).Get(ctx, &resolved); err != nil {
				logger.Warn("forced skill lookup failed; falling through to retrieval", "skillId", in.ForcedSkillID, "error", err)
			} else if resolved != nil {
				skillTools = resolved
				meta.Path = "skill-routed"
				note("Routing to skill " + resolved.Skill.ID)
			} else {
				logger.Info("forced skill not visible to caller; falling through", "skillId", in.ForcedSkillID)
			}
		}
	}

	// 1. Session continuity (ADR 0012): re-fetch the active skill under the
	// caller's CURRENT roles (fail closed), then a cheap fit check. Any miss
	// falls through to the full path — never an error.
	if skillTools == nil && state.ActiveSkillID != "" && in.Caller.Subject != "" {
		var resolved *activities.SkillTools
		err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
			Caller:  in.Caller,
			SkillID: state.ActiveSkillID,
		}).Get(ctx, &resolved)
		if err == nil && resolved != nil {
			var fits bool
			if err := workflow.ExecuteActivity(actx, activities.CheckSkillFitActivityName, activities.CheckSkillFitInput{
				Request: in.Message,
				Skill:   resolved.Skill,
			}).Get(ctx, &fits); err == nil && fits {
				skillTools = resolved
				meta.Path = "skill-continued"
				note("Continuing with skill " + resolved.Skill.ID)
			}
		}
		if skillTools == nil {
			state.ActiveSkillID = "" // stale or unfit — full re-selection
		}
	}

	if skillTools == nil {
		// 2. Capability gate (ADR 0019): purely conversational turns skip
		// the catalog entirely. Gate errors default to the capability path.
		needsCapability := true
		if err := workflow.ExecuteActivity(actx, activities.CheckNeedsCapabilityActivityName, in.Message).Get(ctx, &needsCapability); err != nil {
			logger.Warn("capability gate failed; assuming capabilities needed", "error", err)
			needsCapability = true
		}
		if !needsCapability || in.Caller.Subject == "" {
			reply, err := bareAnswer(ctx, actx, state)
			return reply, meta, err
		}

		// 3. Retrieval (RBAC-filtered), skills and agents in parallel-ish.
		note("Selecting a skill…")
		var skills []catalog.SkillDescriptor
		if err := workflow.ExecuteActivity(actx, activities.RetrieveSkillsActivityName, activities.RetrieveInput{
			Caller:  in.Caller,
			Request: in.Message,
		}).Get(ctx, &skills); err != nil {
			logger.Warn("skill retrieval failed; answering bare", "error", err)
		}
		var agents []catalog.AgentDescriptor
		if err := workflow.ExecuteActivity(actx, activities.RetrieveAgentsActivityName, activities.RetrieveInput{
			Caller:  in.Caller,
			Request: in.Message,
		}).Get(ctx, &agents); err != nil {
			logger.Warn("agent retrieval failed", "error", err)
		}
		if len(skills) == 0 && len(agents) == 0 {
			reply, err := bareAnswer(ctx, actx, state)
			return reply, meta, err
		}

		// 4. Selection: skill vs agent when both kinds are on the table,
		// plain skill selection otherwise.
		var skillID string
		if len(agents) > 0 {
			var choice activities.DelegateChoice
			if err := workflow.ExecuteActivity(actx, activities.SelectDelegateActivityName, activities.SelectDelegateInput{
				Request: in.Message,
				Skills:  skills,
				Agents:  agents,
			}).Get(ctx, &choice); err != nil {
				logger.Warn("delegate selection failed; answering bare", "error", err)
			}
			if choice.Kind == activities.DelegateAgent {
				if agent := findAgent(choice.ID, agents); agent != nil {
					return delegateToAgent(ctx, state, in, *agent, &meta, note)
				}
			}
			skillID = ""
			if choice.Kind == activities.DelegateSkill {
				skillID = choice.ID
			}
		} else {
			if err := workflow.ExecuteActivity(actx, activities.SelectSkillActivityName, activities.SelectSkillInput{
				Request:    in.Message,
				Candidates: skills,
			}).Get(ctx, &skillID); err != nil {
				skillID = ""
			}
		}
		if skillID == "" {
			reply, err := bareAnswer(ctx, actx, state)
			return reply, meta, err
		}

		// 5. Resolve the skill's declared tools directly (no re-ranking),
		// RBAC re-checked (ADR 0008).
		if err := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
			Caller:  in.Caller,
			SkillID: skillID,
		}).Get(ctx, &skillTools); err != nil || skillTools == nil {
			reply, err := bareAnswer(ctx, actx, state)
			return reply, meta, err
		}
		meta.Path = "skill"
		note("Using skill " + skillTools.Skill.ID)
	}

	state.ActiveSkillID = skillTools.Skill.ID
	meta.SkillID = skillTools.Skill.ID

	// 6. plan ⇄ runTool loop.
	var history []activities.ActionRecord
	var lastSuccess *ToolOutcome
	for step := 0; step < maxToolSteps; step++ {
		var plan activities.PlannedAction
		if err := workflow.ExecuteActivity(actx, activities.PlanActionActivityName, activities.PlanActionInput{
			Request:       in.Message,
			SkillMarkdown: skillTools.Skill.Markdown,
			Tools:         skillTools.Tools,
			History:       history,
		}).Get(ctx, &plan); err != nil {
			return "", meta, fmt.Errorf("action planner: %w", err)
		}

		if plan.Action == activities.ActionRespond {
			return plan.Response, meta, nil
		}
		if plan.Action == activities.ActionFinish {
			break
		}

		// Re-validate the planner's tool choice against the skill's
		// resolved, role-visible tools — never trusted blindly (ADR 0008).
		if !toolInScope(plan.ToolID, skillTools) {
			logger.Warn("planner chose out-of-scope tool", "toolId", plan.ToolID)
			history = append(history, activities.ActionRecord{
				ToolID: plan.ToolID, Input: plan.ToolInput,
				Error: "tool not available to this skill/caller",
			})
			continue
		}
		if repeatsLastCall(history, plan) {
			logger.Warn("planner repeated identical call; finishing", "toolId", plan.ToolID)
			break
		}

		// Re-inject the tool's stored continuation token (ADR 0017): opaque,
		// server-side only, prepended to the SAME tool's next input.
		toolInput := plan.ToolInput
		if token := state.ToolContinuations[plan.ToolID]; token != "" {
			toolInput = continuation.Prepend(token, toolInput)
		}

		note("Running " + plan.ToolID + "…")
		outcome, err := runTool(ctx, RunToolParams{
			ToolRef: plan.ToolID,
			Args:    []string{toolInput},
			OnProgress: func(e messaging.Event) {
				line := e.Message
				if e.Stage != "" {
					line = e.Stage + ": " + line
				}
				note(line)
			},
		})
		if err != nil {
			return "", meta, err
		}
		meta.ToolCalls = append(meta.ToolCalls, plan.ToolID)
		record := activities.ActionRecord{ToolID: plan.ToolID, Input: plan.ToolInput, Succeeded: outcome.Succeeded}
		if outcome.Succeeded {
			// Strip a leading continuation marker BEFORE the result reaches
			// planner history, compose, or the reply — the transcript never
			// carries resume state.
			token, stripped := continuation.Extract(outcome.Result)
			if token != "" {
				if state.ToolContinuations == nil {
					state.ToolContinuations = map[string]string{}
				}
				state.ToolContinuations[plan.ToolID] = token
			}
			outcome.Result = stripped
			record.Result = stripped
			lastSuccess = &outcome
			note(plan.ToolID + " finished")
		} else {
			record.Error = outcome.ErrorCode + ": " + outcome.ErrorMessage
			note(plan.ToolID + " failed: " + outcome.ErrorCode)
		}
		history = append(history, record)
	}

	// 7. Compose (ADR 0015): additive prefix/suffix around the verbatim
	// result of the last successful tool call.
	if lastSuccess != nil {
		note("Composing reply…")
		var framed activities.ComposedResponse
		if err := workflow.ExecuteActivity(actx, activities.ComposeResponseActivityName, activities.ComposeResponseInput{
			Request:       in.Message,
			SkillMarkdown: skillTools.Skill.Markdown,
			Result:        lastSuccess.Result,
		}).Get(ctx, &framed); err != nil {
			logger.Warn("compose failed; returning bare result", "error", err)
		}
		return framed.Prefix + lastSuccess.Result + framed.Suffix, meta, nil
	}
	if len(history) > 0 {
		last := history[len(history)-1]
		return fmt.Sprintf("I couldn't complete that: %s failed (%s).", last.ToolID, last.Error), meta, nil
	}
	return bareAnswerWithMeta(ctx, actx, state, meta)
}

func bareAnswer(ctx workflow.Context, actx workflow.Context, state *ConversationState) (string, error) {
	var reply string
	err := workflow.ExecuteActivity(actx, activities.CompleteTurnActivityName, activities.CompleteTurnInput{
		SystemPrompt: systemPrompt,
		Messages:     toLLMMessages(state.History),
	}).Get(ctx, &reply)
	return reply, err
}

func bareAnswerWithMeta(ctx workflow.Context, actx workflow.Context, state *ConversationState, meta TurnMeta) (string, TurnMeta, error) {
	reply, err := bareAnswer(ctx, actx, state)
	return reply, meta, err
}

func toolInScope(toolID string, st *activities.SkillTools) bool {
	for _, t := range st.Tools {
		if t.ID == toolID {
			return true
		}
	}
	return false
}

func repeatsLastCall(history []activities.ActionRecord, plan activities.PlannedAction) bool {
	if len(history) == 0 {
		return false
	}
	last := history[len(history)-1]
	return last.ToolID == plan.ToolID && last.Input == plan.ToolInput
}
