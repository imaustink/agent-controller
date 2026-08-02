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

	"durable-agents/internal/authz"
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

	retrieveCalls       int
	retrieveAgentCalls  int
	fitCalls            int
	planCalls           int
	resolveAgentCalls   int
	selectDelegateCalls int
	retrieveToolCalls   int
	toolFitCalls        int
	toolFitInputs       []activities.CheckToolFitInput
	completeTurnInputs  []activities.CompleteTurnInput

	// Authorization knobs. Nil means "authorized with no credentials", which
	// is what an Agent or Tool declaring no identityProviders gets anyway.
	authorizeVerdict      func() authz.Verdict
	authorizeInputs       []activities.AuthorizeInput
	toolCredentialVerdict func() authz.Verdict
	toolCredentialInputs  []activities.ToolCredentialsInput

	// knobs
	needsCapability bool
	skills          []catalog.SkillDescriptor
	agents          []catalog.AgentDescriptor
	selected        string
	delegate        activities.DelegateChoice
	skillTools      *activities.SkillTools
	// skillToolsByID, when set, resolves per skill id instead of returning
	// skillTools for anything — needed to distinguish a route naming a skill
	// the caller cannot see from one they can.
	skillToolsByID map[string]*activities.SkillTools
	// resolvedAgent is what ResolveAgent returns for a forced agent id; nil
	// means "gone, or not visible to this caller".
	resolvedAgent *catalog.AgentDescriptor
	// forcedSkillID/forcedAgentID ride every sendTurn, as if an
	// IntegrationRoute had matched this turn's event descriptor.
	forcedSkillID string
	forcedAgentID string
	// catalogTools is what a full-catalog sweep returns (the no-match
	// fallback and the out-of-scope guard); toolFits is the relevance gate's
	// verdict on each, defaulting to "no fit" like the real checker.
	catalogTools    []catalog.ToolDescriptor
	toolFits        bool
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
	env.RegisterWorkflowWithOptions(workflows.PodAgentWorkflow, workflow.RegisterOptions{Name: workflows.PodAgentWorkflowName})

	reg := func(name string, fn any) {
		env.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: name})
	}
	reg(activities.CheckNeedsCapabilityActivityName, func(context.Context, string) (bool, error) {
		return le.needsCapability, nil
	})
	reg(activities.CompleteTurnActivityName, func(_ context.Context, in activities.CompleteTurnInput) (string, error) {
		le.completeTurnInputs = append(le.completeTurnInputs, in)
		return "bare answer", nil
	})
	reg(activities.RetrieveToolsActivityName, func(context.Context, activities.RetrieveInput) ([]catalog.ToolDescriptor, error) {
		le.retrieveToolCalls++
		return le.catalogTools, nil
	})
	reg(activities.CheckToolFitActivityName, func(_ context.Context, in activities.CheckToolFitInput) (bool, error) {
		le.toolFitCalls++
		le.toolFitInputs = append(le.toolFitInputs, in)
		return le.toolFits, nil
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
		le.selectDelegateCalls++
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
	reg(activities.ResolveSkillToolsActivityName, func(_ context.Context, in activities.ResolveSkillToolsInput) (*activities.SkillTools, error) {
		if le.skillToolsByID != nil {
			return le.skillToolsByID[in.SkillID], nil
		}
		return le.skillTools, nil
	})
	reg(activities.ResolveAgentActivityName, func(context.Context, activities.ResolveAgentInput) (*catalog.AgentDescriptor, error) {
		le.resolveAgentCalls++
		return le.resolvedAgent, nil
	})
	// The authorization pre-flight. Only reached by an Agent that declares
	// identityProviders, so most fixtures never touch it; registered here so
	// the ones that do can flip a knob instead of racing a second
	// registration.
	reg(activities.AuthorizeActivityName, func(_ context.Context, in activities.AuthorizeInput) (authz.Verdict, error) {
		le.authorizeInputs = append(le.authorizeInputs, in)
		if le.authorizeVerdict != nil {
			return le.authorizeVerdict(), nil
		}
		return authz.Verdict{Kind: authz.KindAuthorized}, nil
	})
	reg(activities.ResolveToolCredentialsActivityName, func(_ context.Context, in activities.ToolCredentialsInput) (authz.Verdict, error) {
		le.toolCredentialInputs = append(le.toolCredentialInputs, in)
		if le.toolCredentialVerdict != nil {
			return le.toolCredentialVerdict(), nil
		}
		return authz.Verdict{Kind: authz.KindAuthorized}, nil
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
			Message:       message,
			Caller:        activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
			ForcedSkillID: le.forcedSkillID,
			ForcedAgentID: le.forcedAgentID,
		})
	}, at)
}

// signalToolSuccess delivers a succeeded event for launch #launchIndex once
// that launch exists, rescheduling in virtual time until it does.
func (le *loopEnv) signalToolSuccess(launchIndex int, resultJSON string) {
	var attempt func()
	attempt = func() {
		if len(le.launches) <= launchIndex {
			le.env.RegisterDelayedCallback(attempt, 100*time.Millisecond)
			return
		}
		jobID := le.launches[launchIndex].JobID
		le.env.SignalWorkflow(workflows.ToolEventSignalPrefix+jobID, messaging.Event{
			JobID: jobID, Seq: 1, TS: "t", Type: "succeeded", Result: json.RawMessage(resultJSON),
		})
	}
	attempt()
}

func recipesSkillTools() *activities.SkillTools {
	return &activities.SkillTools{
		// ToolIDs mirrors what DecodeSkill reads off spec.toolRefs and what
		// ResolveSkillTools then resolves Tools from — a descriptor with
		// Tools but no ToolIDs cannot occur in production.
		Skill: catalog.SkillDescriptor{
			ID: "recipes", Description: "recipe workflows",
			Markdown: "# Recipes\nScrape then present.",
			ToolIDs:  []string{"recipe-scraper"},
		},
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
		le.signalToolSuccess(0, `"# Pasta\nBoil water."`)
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
		le.signalToolSuccess(0, `"<!-- continuation: tok-abc -->\n\n# Pasta\nBoil water."`)
	}, time.Second)

	le.sendTurn(t, "turn-2", "now publish it", &second, 2*time.Second)
	le.env.RegisterDelayedCallback(func() {
		le.signalToolSuccess(1, `"published"`)
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

// An IntegrationRoute names its target outright (upstream ADR 0024), so a
// routed turn must not pay for retrieval it cannot use.
func TestIntegrationRouteForcedAgentBypassesRetrieval(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	le.forcedAgentID = agent.ID
	le.resolvedAgent = &agent
	le.skillTools = recipesSkillTools() // the child resolves its skillRefs
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionFinish, Message: "Triaged."},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "Triage acme/widgets#7", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Triaged.", result.Reply)
	require.Equal(t, "agent-routed", result.Meta.Path)
	require.Equal(t, agent.ID, result.Meta.AgentID)
	require.Zero(t, le.retrieveCalls, "a routed turn must skip skill retrieval")
	// Not retrieveAgentCalls: the child runs its own agent retrieval for
	// sub-delegation, which has nothing to do with the parent's bypass.
	// SelectDelegate is the parent-only signal that retrieval-based selection
	// ran at all.
	require.Zero(t, le.selectDelegateCalls, "a routed turn must skip delegate selection")
}

func TestIntegrationRouteForcedSkillBypassesRetrieval(t *testing.T) {
	le := newLoopEnv(t)
	le.forcedSkillID = "recipes"
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{{Action: activities.ActionRespond, Response: "routed reply"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "Publish the recipe at example.com", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "routed reply", result.Reply)
	require.Equal(t, "skill-routed", result.Meta.Path)
	require.Equal(t, "recipes", result.Meta.SkillID)
	require.Zero(t, le.retrieveCalls)
	require.Zero(t, le.fitCalls, "deterministic dispatch needs no fit check")
}

// A route is operator config, not an authorization decision: the named target
// is re-resolved under the caller's current roles, and a target they cannot
// see is a miss rather than a bypass or an error.
func TestIntegrationRouteInvisibleTargetFallsThroughToRetrieval(t *testing.T) {
	le := newLoopEnv(t)
	le.forcedAgentID = "claude-code-swe-agent"
	le.resolvedAgent = nil // roles revoked, or the CR is gone
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{{Action: activities.ActionRespond, Response: "retrieved reply"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "Triage acme/widgets#7", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, 1, le.resolveAgentCalls)
	require.Equal(t, "skill", result.Meta.Path, "a route miss falls through to ordinary retrieval")
	require.Equal(t, 1, le.retrieveCalls)
}

// Re-applying a trigger label while an episode is still in flight must feed
// the running agent, not start a second one — on a real coding agent that
// would mean a second branch and a second PR (upstream ADR 0033's reasoning,
// and why the route check sits after the active-episode check).
func TestIntegrationRouteYieldsToAnActiveEpisode(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	le.forcedAgentID = agent.ID
	le.resolvedAgent = &agent
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionAskUser, Question: "Which branch?"},
		{Action: activities.AgentActionFinish, Message: "Done on main."},
	}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "Triage acme/widgets#7", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "Triage acme/widgets#7", &second, 2*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "agent-routed", first.Meta.Path)
	require.Equal(t, "agent-continued", second.Meta.Path, "the re-applied label fed the running episode")
	require.Equal(t, "Done on main.", second.Reply)
	require.Equal(t, 1, le.resolveAgentCalls, "the second turn must not re-resolve or re-dispatch the route")
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

// Nothing in the catalog covers the request, so the turn still gets answered
// — and says so, since the point of the footer is that a skill could be
// authored for next time.
func TestAgentLoopNoMatchFallsBackToBare(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "" // selector: nothing genuinely fits
	le.catalogTools = nil

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "write me a poem about kubernetes", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())
	require.Equal(t, "bare answer"+workflows.SelfImprovementFooter, result.Reply)
	require.Equal(t, "fallback-bare", result.Meta.Path)
}

// The capability gate (ADR 0019) is a different "bare" from the fallback's:
// a greeting was never a catalog miss, so it gets no footer and never sweeps
// the catalog.
func TestCapabilityGateBareAnswerCarriesNoFooter(t *testing.T) {
	le := newLoopEnv(t)
	le.needsCapability = false

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "hey there", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())
	require.Equal(t, "bare answer", result.Reply)
	require.Equal(t, "bare", result.Meta.Path)
	require.Zero(t, le.retrieveToolCalls)
}

func kubectlTool() catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID: "kubectl-readonly", Description: "read-only kubectl against the cluster",
		AllowedRoles: []string{"cook"},
	}
}

// No skill matched, but one catalog tool is an unambiguous fit — call it
// rather than answering from general knowledge.
func TestNoMatchFallbackRunsAFittingCatalogTool(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = "" // no skill fits
	le.catalogTools = []catalog.ToolDescriptor{kubectlTool()}
	le.toolFits = true
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "kubectl-readonly", ToolInput: "get pods -n default"},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "what pods are running?", &result, time.Millisecond)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"pod-a  Running"`) }, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "fallback-tool", result.Meta.Path)
	require.Equal(t, []string{"kubectl-readonly"}, result.Meta.ToolCalls)
	require.Equal(t, "Here you go:\npod-a  Running\nEnjoy!"+workflows.SelfImprovementFooter, result.Reply)
	require.Equal(t, 1, le.toolFitCalls)
}

// The gate that makes the fallback safe: similarity search matches on word
// overlap, so "create a recipe" surfaces a tool that creates repositories.
// A candidate that fails the fit check must never reach the planner.
func TestNoMatchFallbackRejectsALooseKeywordMatch(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = ""
	le.catalogTools = []catalog.ToolDescriptor{
		{ID: "github-repo-create", Description: "create or clone a repository", AllowedRoles: []string{"cook"}},
	}
	le.toolFits = false // the checker's default, and the whole point

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "create a recipe for carbonara", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, 1, le.toolFitCalls)
	require.Zero(t, le.planCalls, "a rejected candidate must never reach the planner")
	require.Equal(t, "fallback-bare", result.Meta.Path)
	require.Equal(t, "bare answer"+workflows.SelfImprovementFooter, result.Reply)
	require.Empty(t, le.launches, "nothing should have been launched")
}

// The footer is a UI hint, not content. Left in the transcript it re-enters
// every later turn's prompt and biases selection toward repeating "no match".
func TestSelfImprovementFooterNeverEntersTheTranscript(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = ""
	le.needsCapability = true

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "write me a poem about kubernetes", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "and another", &second, 2*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Contains(t, first.Reply, workflows.SelfImprovementFooter, "the user does see it")
	require.NotEmpty(t, le.completeTurnInputs)
	for _, in := range le.completeTurnInputs {
		for _, m := range in.Messages {
			require.NotContains(t, m.Content, "No existing skill or agent matched",
				"the footer must not reach a later turn's prompt")
		}
	}
}

// Active-skill continuity judges topic ("is this still the same task?"), which
// cannot see that the turn names a capability the skill's own tools could
// never satisfy. Without this guard the user gets "I can't do that" from a
// system that can.
func TestOutOfScopeToolRequestBreaksActiveSkillContinuity(t *testing.T) {
	le := newLoopEnv(t)
	le.skillToolsByID = map[string]*activities.SkillTools{"recipes": recipesSkillTools()}
	le.fits = true // topic-wise, the fit checker says "still the same task"
	le.catalogTools = []catalog.ToolDescriptor{kubectlTool()}
	le.toolFits = true // ...but a tool outside the skill genuinely fits
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = ""

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "use your kubectl access to debug this", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName,
		&workflows.ConversationState{ActiveSkillID: "recipes"})
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.NotEqual(t, "skill-continued", result.Meta.Path,
		"the active skill must not absorb a request for a capability it lacks")
	require.Equal(t, 1, le.retrieveCalls, "the turn reached full retrieval")
	require.NotEmpty(t, le.toolFitInputs)
	require.Equal(t, "kubectl-readonly", le.toolFitInputs[0].Tool.ID)
}

// The guard must not fire on the ordinary case: a turn genuinely continuing
// its skill, where the only nearby tools are the skill's own.
func TestActiveSkillContinuesWhenNothingOutOfScopeFits(t *testing.T) {
	le := newLoopEnv(t)
	le.skillToolsByID = map[string]*activities.SkillTools{"recipes": recipesSkillTools()}
	le.fits = true
	// The sweep only surfaces the skill's own tool, so there is nothing
	// out-of-scope to even fit-check.
	le.catalogTools = []catalog.ToolDescriptor{{ID: "recipe-scraper", Description: "scrape recipe from url"}}
	le.toolFits = true
	le.plans = []activities.PlannedAction{{Action: activities.ActionRespond, Response: "continued reply"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "now publish it", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName,
		&workflows.ConversationState{ActiveSkillID: "recipes"})
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "skill-continued", result.Meta.Path)
	require.Zero(t, le.toolFitCalls, "the skill's own tools are never fit-checked as out-of-scope")
	require.Zero(t, le.retrieveCalls, "continuity still skips retrieval")
}
