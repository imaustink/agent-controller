package workflows

import (
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/approval"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// PendingApproval anchors a turn that paused to ask the user to approve a tool
// call (ADR 0003). Like PendingIdentityLink it carries the ORIGINAL request so
// the resuming turn continues the task the user asked for rather than the word
// "approve". It also carries the exact tool id + input the gate will let through
// once, so the resumed loop re-plans normally and this one call runs without a
// second prompt. Nil when no approval is outstanding.
type PendingApproval struct {
	OriginalRequest string `json:"originalRequest,omitempty"`
	SkillID         string `json:"skillId,omitempty"`
	ToolID          string `json:"toolId"`
	ToolInput       string `json:"toolInput,omitempty"`
	ToolInstanceKey string `json:"toolInstanceKey,omitempty"`
}

// resumePendingApproval runs at the top of a turn that paused for approval. It
// interprets this turn's message as the decision and re-arms the normal agent
// loop — it never re-implements tool dispatch. On a clear decision it re-resolves
// the skill under the caller's CURRENT roles (fail closed) and hands the caller
// either an approved one-shot (the gate lets exactly this call through) or the
// id of a denied tool (the gate surfaces it to the planner as a failed call). An
// ambiguous reply re-asks and keeps the anchor.
//
// Returns: resolved skill (nil unless the anchor was consumed); approved (a
// one-shot {ToolID,ToolInput} the gate matches); deniedToolID; an early reply
// with handled=true when the turn is answered here (re-ask or the anchor went
// stale); err from the skill re-resolution.
func resumePendingApproval(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in *TurnInput,
	meta *TurnMeta,
	note func(string),
) (resolved *activities.SkillTools, approved *PendingApproval, deniedToolID, reply string, handled bool, err error) {
	pa := state.PendingApproval
	logger := workflow.GetLogger(ctx)

	decision := approval.ParseDecision(in.Message)
	if decision == approval.DecisionPending {
		// Not a clear approve/deny — ask again and keep the anchor so the next
		// reply still counts. The gate never executes on an ambiguous answer.
		note("Awaiting your approval")
		return nil, nil, "", approval.Prompt(pa.ToolID), true, nil
	}

	// Re-resolve the skill under CURRENT roles (fail closed): an anchor is not a
	// capability, and roles may have been revoked while the human deliberated.
	var sk *activities.SkillTools
	if e := workflow.ExecuteActivity(actx, activities.ResolveSkillToolsActivityName, activities.ResolveSkillToolsInput{
		Caller:  in.Caller,
		SkillID: pa.SkillID,
	}).Get(ctx, &sk); e != nil || sk == nil {
		logger.Info("pending approval's skill is gone or no longer visible; dropping the anchor",
			"skillId", pa.SkillID, "toolId", pa.ToolID)
		state.PendingApproval = nil
		return nil, nil, "", "That action is no longer available. Please ask again.", true, nil
	}

	toolID := pa.ToolID
	toolInput := pa.ToolInput
	if pa.OriginalRequest != "" {
		in.Message = pa.OriginalRequest // continue the real task, not "approve"
	}
	meta.Path = "skill-continued"
	meta.SkillID = sk.Skill.ID
	state.PendingApproval = nil // consumed

	if decision == approval.DecisionDenied {
		note(toolID + " was denied")
		return sk, nil, toolID, "", false, nil
	}

	note("Approved " + toolID)
	return sk, &PendingApproval{ToolID: toolID, ToolInput: toolInput}, "", "", false, nil
}

// requestAgentApproval runs the approval round-trip inside a sub-agent workflow:
// it bubbles the approval prompt to the parent as a question and durably waits
// for the answer on the same AgentPrompt channel ask_user uses — no pod idles on
// the human. An ambiguous answer is re-asked a few times, then fails safe to
// denied so the loop can never hang on persistently unclear input.
func requestAgentApproval(ctx workflow.Context, up func(AgentUp), prompts workflow.ReceiveChannel, toolID string) approval.Decision {
	const maxReasks = 3
	for attempt := 0; attempt <= maxReasks; attempt++ {
		up(AgentUp{Message: approval.Prompt(toolID)})
		var answer AgentPrompt
		prompts.Receive(ctx, &answer)
		switch approval.ParseDecision(answer.Message) {
		case approval.DecisionApproved:
			return approval.DecisionApproved
		case approval.DecisionDenied:
			return approval.DecisionDenied
		}
		// Ambiguous — ask again.
	}
	return approval.DecisionDenied
}
