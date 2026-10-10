package workflows_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/approval"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
)

// approvalSkillTools is recipesSkillTools with the scraper carrying a given
// approval policy (ADR 0003).
func approvalSkillTools(policy string) *activities.SkillTools {
	st := recipesSkillTools()
	st.Tools[0].Approval = policy
	return st
}

// An "always" tool pauses the turn with the shared prompt and launches nothing;
// the next turn's "approve" resumes and actually runs it.
func TestApprovalGatePausesThenRunsOnApprove(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{approvalSkillTools("always").Skill}
	le.selected = "recipes"
	le.skillTools = approvalSkillTools("always")
	le.fits = true // turn 2 re-resolves the same skill
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"}, // turn 1: paused
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"}, // turn 2: approved, runs
		{Action: activities.ActionFinish},
	}

	var paused, resumed workflows.TurnResult
	le.sendTurn(t, "turn-1", "scrape the pasta recipe", &paused, time.Millisecond)
	le.sendTurn(t, "turn-2", "approve", &resumed, time.Second)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"# Pasta\nBoil water."`) }, 2*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	// Turn 1 paused: the exact shared prompt, and NOTHING launched.
	require.Equal(t, approval.Prompt("recipe-scraper"), paused.Reply)
	require.Empty(t, paused.Meta.ToolCalls)
	require.Len(t, le.launches, 1, "the tool must launch exactly once — only after approval")
	// Turn 2 ran the tool and composed an answer.
	require.Equal(t, "Here you go:\n# Pasta\nBoil water.\nEnjoy!", resumed.Reply)
	require.Equal(t, []string{"recipe-scraper"}, resumed.Meta.ToolCalls)
	require.Equal(t, "skill-continued", resumed.Meta.Path)
}

// "deny" surfaces the call to the planner as a failed result and never launches.
func TestApprovalGateDeniedNeverRuns(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{approvalSkillTools("always").Skill}
	le.selected = "recipes"
	le.skillTools = approvalSkillTools("always")
	le.fits = true
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"}, // turn 1: paused
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"}, // turn 2: denied -> failed record
		{Action: activities.ActionRespond, Response: "Understood — I won't run that."},
	}

	var paused, resumed workflows.TurnResult
	le.sendTurn(t, "turn-1", "scrape the pasta recipe", &paused, time.Millisecond)
	le.sendTurn(t, "turn-2", "deny", &resumed, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, approval.Prompt("recipe-scraper"), paused.Reply)
	require.Equal(t, "Understood — I won't run that.", resumed.Reply)
	require.Nil(t, le.launched, "a denied tool must never launch")
	require.Empty(t, resumed.Meta.ToolCalls)
	// The planner must have seen the denial as a failed action record.
	lastPlan := le.planInputs[len(le.planInputs)-1]
	require.NotEmpty(t, lastPlan.History)
	require.Contains(t, lastPlan.History[len(lastPlan.History)-1].Error, approval.DeniedCode)
}

// A tool with "never" (the default) runs silently in one turn — proving the
// gate does not disturb existing behavior.
func TestApprovalNeverRunsSilently(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{approvalSkillTools("never").Skill}
	le.selected = "recipes"
	le.skillTools = approvalSkillTools("never")
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"},
		{Action: activities.ActionFinish},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "scrape the pasta recipe", &result, time.Millisecond)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"# Pasta\nBoil water."`) }, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Here you go:\n# Pasta\nBoil water.\nEnjoy!", result.Reply)
	require.Equal(t, []string{"recipe-scraper"}, result.Meta.ToolCalls)
	require.Len(t, le.launches, 1)
}

// A sub-agent whose tool needs approval degrades GRACEFULLY when no human
// answers in time (ADR 0003): the approval wait is bounded by the agent's
// approvalTimeout, the gated tool never runs, and the planner sees an
// `approval_timeout` failed action it can reason over — not a hang. Drives the
// child AgentWorkflow directly, since the timeout fires between conversation
// turns with no one actively consuming the up-channel.
func TestSubAgentApprovalTimesOutGracefully(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.SkillRefs = nil
	agent.ToolRefs = []string{"kubectl-readonly"}
	agent.ApprovalTimeoutSeconds = 60 // virtual time fires it regardless of magnitude

	gated := kubectlTool()
	gated.Approval = "always"
	le.agentTools = []catalog.ToolDescriptor{gated}
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionCallTool, ToolID: "kubectl-readonly", ToolInput: "get pods"},
		{Action: activities.AgentActionFinish, Message: "I couldn't get that approved, so I stopped."},
	}
	// Executing the child directly: absorb its up-signals (incl. the approval
	// prompt) and NEVER deliver an AgentPrompt, so the timer is the only way out.
	le.env.OnSignalExternalWorkflow(mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Return(nil)

	le.env.ExecuteWorkflow(workflows.AgentWorkflowName, workflows.AgentWorkflowInput{
		Agent:            agent,
		Goal:             "list the pods",
		Caller:           activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
		ParentWorkflowID: "some-parent",
		Depth:            1,
	})
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	// The gated tool never launched — nobody approved it.
	require.Empty(t, le.launches, "a tool awaiting approval must never run on timeout")
	// The planner's next call saw the timeout as a failed action, distinctly coded.
	require.GreaterOrEqual(t, len(le.agentPlanInputs), 2)
	hist := le.agentPlanInputs[len(le.agentPlanInputs)-1].History
	require.NotEmpty(t, hist)
	require.Contains(t, hist[len(hist)-1].Error, approval.TimeoutCode)
}
