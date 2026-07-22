package workflows_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/catalog"
	"durable-agents/internal/messaging"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
	"durable-agents/internal/toolrun"
)

// loopEnv fakes every activity the agent loop touches and counts calls.
type loopEnv struct {
	env      *testsuite.TestWorkflowEnvironment
	launched *activities.LaunchToolRunInput
	launches []activities.LaunchToolRunInput

	retrieveCalls      int
	retrieveAgentCalls int
	fitCalls           int
	planCalls          int

	// knobs
	needsCapability bool
	skills          []catalog.SkillDescriptor
	agents          []catalog.AgentDescriptor
	selected        string
	delegate        activities.DelegateChoice
	skillTools      *activities.SkillTools
	fits            bool
	plans           []activities.PlannedAction      // returned in order
	agentPlans      []activities.PlannedAgentAction // returned in order
	agentPlanCalls  int
	agentPlanInputs []activities.PlanAgentActionInput
}

func newLoopEnv(t *testing.T) *loopEnv {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	le := &loopEnv{env: suite.NewTestWorkflowEnvironment(), needsCapability: true}
	env := le.env

	env.RegisterWorkflowWithOptions(workflows.ConversationWorkflow, workflow.RegisterOptions{Name: workflows.ConversationWorkflowName})
	env.RegisterWorkflowWithOptions(workflows.AgentWorkflow, workflow.RegisterOptions{Name: workflows.AgentWorkflowName})

	reg := func(name string, fn any) {
		env.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: name})
	}
	reg(activities.CheckNeedsCapabilityActivityName, func(context.Context, string) (bool, error) {
		return le.needsCapability, nil
	})
	reg(activities.CompleteTurnActivityName, func(context.Context, activities.CompleteTurnInput) (string, error) {
		return "bare answer", nil
	})
	reg(activities.RetrieveSkillsActivityName, func(_ context.Context, in activities.RetrieveInput) ([]catalog.SkillDescriptor, error) {
		le.retrieveCalls++
		return le.skills, nil
	})
	reg(activities.RetrieveAgentsActivityName, func(_ context.Context, in activities.RetrieveInput) ([]catalog.AgentDescriptor, error) {
		le.retrieveAgentCalls++
		return le.agents, nil
	})
	reg(activities.SelectDelegateActivityName, func(context.Context, activities.SelectDelegateInput) (activities.DelegateChoice, error) {
		return le.delegate, nil
	})
	reg(activities.PlanAgentActionActivityName, func(_ context.Context, in activities.PlanAgentActionInput) (activities.PlannedAgentAction, error) {
		le.agentPlanInputs = append(le.agentPlanInputs, in)
		plan := le.agentPlans[min(le.agentPlanCalls, len(le.agentPlans)-1)]
		le.agentPlanCalls++
		return plan, nil
	})
	reg(activities.SelectSkillActivityName, func(context.Context, activities.SelectSkillInput) (string, error) {
		return le.selected, nil
	})
	reg(activities.ResolveSkillToolsActivityName, func(context.Context, activities.ResolveSkillToolsInput) (*activities.SkillTools, error) {
		return le.skillTools, nil
	})
	reg(activities.CheckSkillFitActivityName, func(context.Context, activities.CheckSkillFitInput) (bool, error) {
		le.fitCalls++
		return le.fits, nil
	})
	reg(activities.PlanActionActivityName, func(_ context.Context, in activities.PlanActionInput) (activities.PlannedAction, error) {
		plan := le.plans[min(le.planCalls, len(le.plans)-1)]
		le.planCalls++
		return plan, nil
	})
	reg(activities.ComposeResponseActivityName, func(context.Context, activities.ComposeResponseInput) (activities.ComposedResponse, error) {
		return activities.ComposedResponse{Prefix: "Here you go:\n", Suffix: "\nEnjoy!"}, nil
	})
	reg(activities.LaunchToolRunActivityName, func(_ context.Context, in activities.LaunchToolRunInput) error {
		le.launched = &in
		le.launches = append(le.launches, in)
		return nil
	})
	reg(activities.GetToolRunPhaseActivityName, func(context.Context, string) (toolrun.Status, error) {
		return toolrun.Status{}, nil
	})
	return le
}

func (le *loopEnv) sendTurn(t *testing.T, updateID, message string, result *workflows.TurnResult, at time.Duration) {
	le.env.RegisterDelayedCallback(func() {
		le.env.UpdateWorkflow(workflows.UserTurnUpdate, updateID, &testsuite.TestUpdateCallback{
			OnAccept: func() {},
			OnReject: func(err error) { t.Errorf("update rejected: %v", err) },
			OnComplete: func(success interface{}, err error) {
				require.NoError(t, err)
				switch v := success.(type) {
				case converter.EncodedValue:
					require.NoError(t, v.Get(result))
				case workflows.TurnResult:
					*result = v
				}
			},
		}, workflows.TurnInput{
			Message: message,
			Caller:  activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
		})
	}, at)
}

func recipesSkillTools() *activities.SkillTools {
	return &activities.SkillTools{
		Skill: catalog.SkillDescriptor{ID: "recipes", Description: "recipe workflows", Markdown: "# Recipes\nScrape then present."},
		Tools: []catalog.ToolDescriptor{{ID: "recipe-scraper", Description: "scrape recipe from url", AllowedRoles: []string{"cook"}}},
	}
}

func TestAgentLoopFullSkillPath(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"},
		{Action: activities.ActionFinish},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "get me the pasta recipe from example.com", &result, time.Millisecond)

	// Play the tool: terminal event once the launch is recorded.
	le.env.RegisterDelayedCallback(func() {
		require.NotNil(t, le.launched)
		le.env.SignalWorkflow(workflows.ToolEventSignalPrefix+le.launched.JobID, messaging.Event{
			JobID: le.launched.JobID, Seq: 1, TS: "t", Type: "succeeded",
			Result: json.RawMessage(`"# Pasta\nBoil water."`),
		})
	}, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Here you go:\n# Pasta\nBoil water.\nEnjoy!", result.Reply)
	require.Equal(t, "skill", result.Meta.Path)
	require.Equal(t, "recipes", result.Meta.SkillID)
	require.Equal(t, []string{"recipe-scraper"}, result.Meta.ToolCalls)
	require.Equal(t, 2, le.planCalls)
}

func TestAgentLoopActiveSkillSkipsRetrieval(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.fits = true
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionRespond, Response: "answered from skill context"},
	}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "start the recipe workflow", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "and now the next step please", &second, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "skill", first.Meta.Path)
	require.Equal(t, "skill-continued", second.Meta.Path, "second turn should ride the active skill")
	require.Equal(t, 1, le.retrieveCalls, "retrieval must run only on the first turn")
	require.Equal(t, 1, le.fitCalls)
}

func TestAgentLoopRejectsOutOfScopeTool(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "delete-cluster", ToolInput: "prod"},
		{Action: activities.ActionRespond, Response: "I can't do that with this skill."},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "delete the cluster", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Nil(t, le.launched, "out-of-scope tool must never launch")
	require.Equal(t, "I can't do that with this skill.", result.Reply)
	require.Empty(t, result.Meta.ToolCalls)
}

func TestAgentLoopContinuationTokenRoundTrip(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.fits = true // turn 2 rides the active skill
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta"},
		{Action: activities.ActionFinish},
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "publish it"},
		{Action: activities.ActionFinish},
	}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "grab https://example.com/pasta", &first, time.Millisecond)
	le.env.RegisterDelayedCallback(func() {
		require.Len(t, le.launches, 1)
		le.env.SignalWorkflow(workflows.ToolEventSignalPrefix+le.launches[0].JobID, messaging.Event{
			JobID: le.launches[0].JobID, Seq: 1, TS: "t", Type: "succeeded",
			Result: json.RawMessage(`"<!-- continuation: tok-abc -->\n\n# Pasta\nBoil water."`),
		})
	}, time.Second)

	le.sendTurn(t, "turn-2", "now publish it", &second, 2*time.Second)
	le.env.RegisterDelayedCallback(func() {
		require.Len(t, le.launches, 2)
		le.env.SignalWorkflow(workflows.ToolEventSignalPrefix+le.launches[1].JobID, messaging.Event{
			JobID: le.launches[1].JobID, Seq: 1, TS: "t", Type: "succeeded",
			Result: json.RawMessage(`"published"`),
		})
	}, 3*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	// Turn 1: marker stripped from everything user/LLM-visible.
	require.NotContains(t, first.Reply, "continuation", "token must never reach the transcript")
	require.Contains(t, first.Reply, "# Pasta")

	// Turn 2: same tool gets the stored token prepended, server-side only.
	require.Equal(t, "<!-- continuation: tok-abc -->\n\npublish it", le.launches[1].Args[0])
	require.NotContains(t, second.Reply, "tok-abc")
}

func mealPlannerAgent() catalog.AgentDescriptor {
	return catalog.AgentDescriptor{
		ID:          "meal-planner",
		Description: "plans meals for the week",
		AgentPrompt: "You are a meal planner.",
		SkillRefs:   []string{"recipes"},
	}
}

func TestAgentDelegationHITLAcrossTurns(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.agents = []catalog.AgentDescriptor{mealPlannerAgent()}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: "meal-planner"}
	le.skillTools = recipesSkillTools() // the child resolves its skillRefs
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionAskUser, Question: "How many days should I plan for?"},
		{Action: activities.AgentActionFinish, Message: "Planned five days of meals."},
	}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "help me plan meals for the week", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "five days", &second, 2*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	// Turn 1: the child's question IS the reply; episode stays active.
	require.Equal(t, "How many days should I plan for?", first.Reply)
	require.Equal(t, "agent", first.Meta.Path)
	require.Equal(t, "meal-planner", first.Meta.AgentID)

	// Turn 2: the answer went down as a prompt signal; the child finished.
	require.Equal(t, "Planned five days of meals.", second.Reply)
	require.Equal(t, "agent-continued", second.Meta.Path)

	// The child folded the human answer into its planner history.
	require.Len(t, le.agentPlanInputs, 2)
	require.Equal(t, "ask_user", le.agentPlanInputs[1].History[0].ToolID)
	require.Equal(t, "five days", le.agentPlanInputs[1].History[0].Result)
}

func TestAgentWorkflowDepthCapDisablesDelegation(t *testing.T) {
	le := newLoopEnv(t)
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionFinish, Message: "done"},
	}
	// Executing the child directly: its parent doesn't exist in this env,
	// so absorb the up-signals.
	le.env.OnSignalExternalWorkflow(mock.Anything, mock.Anything, mock.Anything, mock.Anything, mock.Anything).Return(nil)

	le.env.ExecuteWorkflow(workflows.AgentWorkflowName, workflows.AgentWorkflowInput{
		Agent:            mealPlannerAgent(),
		Goal:             "plan things",
		Caller:           activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
		ParentWorkflowID: "some-parent",
		Depth:            3, // at the cap
	})
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Zero(t, le.retrieveAgentCalls, "at the depth cap the child must not even retrieve agents")
	require.Len(t, le.agentPlanInputs, 1)
	require.Empty(t, le.agentPlanInputs[0].Agents, "no delegable agents offered at the cap")
}

func TestAgentLoopNoMatchFallsBackToBare(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "" // selector: nothing genuinely fits

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "write me a poem about kubernetes", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())
	require.Equal(t, "bare answer", result.Reply)
	require.Equal(t, "bare", result.Meta.Path)
}
