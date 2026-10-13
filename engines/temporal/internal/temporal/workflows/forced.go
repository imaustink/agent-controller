package workflows

import (
	"fmt"

	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/approval"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

// forcedTarget names the turn's forced target, if any, and its kind. An
// EventTrigger has exactly one target, so at most one of these is set; the
// order only matters for a malformed caller that sets several, and puts the
// most specific (a single tool call) first.
func forcedTarget(in TurnInput) (id, kind string) {
	switch {
	case in.ForcedToolID != "":
		return in.ForcedToolID, "tool"
	case in.ForcedAgentID != "":
		return in.ForcedAgentID, "agent"
	case in.ForcedSkillID != "":
		return in.ForcedSkillID, "skill"
	}
	return "", ""
}

func readOnlyMCPRefusal(toolID string) string {
	return "read_only: " + toolID + " acts with your delegated credentials and cannot run in a read-only request"
}

// runForcedTool runs an EventTrigger's toolRef target ONCE, with the turn's
// ToolInput as its input, skipping the planner (docs/event-triggers.md §1 —
// the one-off FAAS path docs/integrations-gateway.md §4 left open).
//
// It applies every gate a planner-chosen call passes, because how a tool was
// selected must not change what it is allowed to do:
//   - the caller's roles, already re-checked by ResolveTool before this;
//   - the identity gate (toolCredentials, inside runToolCall), with the turn's
//     read-only flag;
//   - the approval policy (ADR 0003). There is no human on an event turn to
//     approve with, so a tool that requires one fails the turn instead of
//     parking it on a prompt nobody will ever see.
func runForcedTool(
	ctx workflow.Context,
	actx workflow.Context,
	state *ConversationState,
	in TurnInput,
	tool catalog.ToolDescriptor,
	meta *TurnMeta,
	note func(string),
) (string, TurnMeta, error) {
	meta.Path = "tool-routed"

	if approval.RequiresHuman(approval.Resolve(tool.Approval, "")) {
		return "", *meta, fmt.Errorf("forced tool %s requires human approval, which an event-triggered run cannot give", tool.ID)
	}

	switch {
	case tool.KnowledgeBaseExec != nil:
		// A knowledge base's generated tools are retrieval faces whose results
		// are material for a synthesized answer, not an answer — there is no
		// planner here to synthesize one. Out of scope for a trigger target.
		return "", *meta, fmt.Errorf("forced tool %s is a knowledge-base tool, which cannot be an event trigger target", tool.ID)

	case tool.MCPExec != nil:
		if in.ReadOnly {
			return "", *meta, fmt.Errorf("%s", readOnlyMCPRefusal(tool.ID))
		}
		note("Calling " + tool.ID + "…")
		var out activities.RunMCPToolOutput
		if err := workflow.ExecuteActivity(actx, activities.RunMCPToolActivityName, activities.RunMCPToolInput{
			Caller:    in.Caller,
			Tool:      tool,
			Arguments: in.ToolInput,
		}).Get(ctx, &out); err != nil {
			return "", *meta, err
		}
		meta.ToolCalls = append(meta.ToolCalls, tool.ID)
		if !out.NeedsLink && !out.Succeeded {
			note(tool.ID + " failed")
			return "I couldn't complete that: " + tool.ID + " failed (" + out.Result + ").", *meta, nil
		}
		return out.Result, *meta, nil
	}

	// Container, local and agent-backed tools: the same single-call path the
	// first-class delegate selection uses, identity gate included.
	return runToolCall(ctx, actx, state, in, tool, in.ToolInput, "Running "+tool.ID+"…", "", meta, note)
}
