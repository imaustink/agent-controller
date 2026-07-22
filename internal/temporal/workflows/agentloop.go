package workflows

import (
	"fmt"

	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/catalog"
	"durable-agents/internal/temporal/activities"
)

// maxToolSteps bounds the plan⇄runTool loop per turn (upstream MAX_TOOL_STEPS).
const maxToolSteps = 4

// TurnMeta reports what the agent loop did, for TurnResult/debugging.
type TurnMeta struct {
	Path      string   `json:"path"`              // bare | skill | skill-continued
	SkillID   string   `json:"skillId,omitempty"` // active skill after this turn
	ToolCalls []string `json:"toolCalls,omitempty"`
}

// runAgentTurn is the ported agent loop: active-skill fit check →
// capability gate → retrieve → select → resolve tools → plan⇄runTool →
// compose. It returns the reply plus which skill (if any) stays active.
// Mirrors agent-controller's graph nodes; sub-agent delegation lands in
// milestone 6.
func runAgentTurn(ctx workflow.Context, actx workflow.Context, state *ConversationState, in TurnInput) (string, TurnMeta, error) {
	logger := workflow.GetLogger(ctx)
	meta := TurnMeta{Path: "bare"}

	// 1. Session continuity (ADR 0012): re-fetch the active skill under the
	// caller's CURRENT roles (fail closed), then a cheap fit check. Any miss
	// falls through to the full path — never an error.
	var skillTools *activities.SkillTools
	if state.ActiveSkillID != "" && in.Caller.Subject != "" {
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

		// 3. Retrieval (RBAC-filtered) + 4. selection.
		var skills []catalog.SkillDescriptor
		if err := workflow.ExecuteActivity(actx, activities.RetrieveSkillsActivityName, activities.RetrieveInput{
			Caller:  in.Caller,
			Request: in.Message,
		}).Get(ctx, &skills); err != nil {
			logger.Warn("skill retrieval failed; answering bare", "error", err)
		}
		if len(skills) == 0 {
			reply, err := bareAnswer(ctx, actx, state)
			return reply, meta, err
		}

		var skillID string
		if err := workflow.ExecuteActivity(actx, activities.SelectSkillActivityName, activities.SelectSkillInput{
			Request:    in.Message,
			Candidates: skills,
		}).Get(ctx, &skillID); err != nil || skillID == "" {
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

		outcome, err := runTool(ctx, RunToolParams{
			ToolRef: plan.ToolID,
			Args:    []string{plan.ToolInput},
		})
		if err != nil {
			return "", meta, err
		}
		meta.ToolCalls = append(meta.ToolCalls, plan.ToolID)
		record := activities.ActionRecord{ToolID: plan.ToolID, Input: plan.ToolInput, Succeeded: outcome.Succeeded}
		if outcome.Succeeded {
			record.Result = outcome.Result
			lastSuccess = &outcome
		} else {
			record.Error = outcome.ErrorCode + ": " + outcome.ErrorMessage
		}
		history = append(history, record)
	}

	// 7. Compose (ADR 0015): additive prefix/suffix around the verbatim
	// result of the last successful tool call.
	if lastSuccess != nil {
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
