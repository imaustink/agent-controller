package workflows_test

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/callertools"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
	"github.com/controller-agent/temporal-engine/internal/toolrun"
)

// registerOpts names an activity registration.
func registerOpts(name string) activity.RegisterOptions {
	return activity.RegisterOptions{Name: name}
}

// loopEnv fakes every activity the agent loop touches and counts calls.
type loopEnv struct {
	env      *testsuite.TestWorkflowEnvironment
	launched *activities.LaunchToolRunInput
	launches []activities.LaunchToolRunInput

	retrieveCalls        int
	retrieveAgentCalls   int
	fitCalls             int
	planCalls            int
	composeCalls         int
	runLocalToolInputs   []activities.RunLocalToolInput
	runLocalToolResult   *messaging.Event
	resolveAgentCalls    int
	selectDelegateCalls  int
	selectDelegateInputs []activities.SelectDelegateInput
	retrieveToolCalls    int
	toolFitCalls         int
	toolFitInputs        []activities.CheckToolFitInput
	completeTurnInputs   []activities.CompleteTurnInput

	planInputs []activities.PlanActionInput
	// agentRunLaunches / agentDownMessages record the bridged pod-agent
	// activity surface (A9).
	agentRunLaunches  []activities.LaunchAgentRunInput
	agentDownMessages []activities.AgentDownInput
	// agentTools is what ResolveAgentTools returns for a child agent's own
	// declared toolRefs (ADR 0028).
	agentTools []catalog.ToolDescriptor
	// callerTools / priorCallerCalls ride every sendTurn, as if the consumer
	// had supplied them in the request body (ADR 0035).
	callerTools      []callertools.Descriptor
	priorCallerCalls []callertools.PriorCall

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
	env.RegisterWorkflowWithOptions(workflows.BridgedAgentWorkflow, workflow.RegisterOptions{Name: workflows.BridgedAgentWorkflowName})

	reg := func(name string, fn any) {
		env.RegisterActivityWithOptions(fn, registerOpts(name))
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
	reg(activities.SelectDelegateActivityName, func(_ context.Context, in activities.SelectDelegateInput) (activities.DelegateChoice, error) {
		le.selectDelegateCalls++
		le.selectDelegateInputs = append(le.selectDelegateInputs, in)
		return le.delegate, nil
	})
	reg(activities.PlanAgentActionActivityName, func(_ context.Context, in activities.PlanAgentActionInput) (activities.PlannedAgentAction, error) {
		le.agentPlanInputs = append(le.agentPlanInputs, in)
		if len(le.agentPlans) == 0 {
			return activities.PlannedAgentAction{}, fmt.Errorf("test setup: the agent planner was called but le.agentPlans is empty")
		}
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
	reg(activities.ResolveAgentToolsActivityName, func(context.Context, activities.ResolveAgentToolsInput) ([]catalog.ToolDescriptor, error) {
		return le.agentTools, nil
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
		le.planInputs = append(le.planInputs, in)
		if len(le.plans) == 0 {
			// An empty list used to index [-1] and surface as an opaque
			// activity panic three retries deep. Say what is actually missing.
			return activities.PlannedAction{}, fmt.Errorf("test setup: the planner was called but le.plans is empty")
		}
		plan := le.plans[min(le.planCalls, len(le.plans)-1)]
		le.planCalls++
		return plan, nil
	})
	reg(activities.ComposeResponseActivityName, func(context.Context, activities.ComposeResponseInput) (activities.ComposedResponse, error) {
		le.composeCalls++
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
	reg(activities.RunLocalToolActivityName, func(_ context.Context, in activities.RunLocalToolInput) (messaging.Event, error) {
		le.runLocalToolInputs = append(le.runLocalToolInputs, in)
		if le.runLocalToolResult != nil {
			return *le.runLocalToolResult, nil
		}
		return messaging.Event{Type: messaging.EventSucceeded, Result: []byte(`"ok"`)}, nil
	})
	registerAgentRunActivities(le)
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
			Message:              message,
			Caller:               activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
			ForcedSkillID:        le.forcedSkillID,
			ForcedAgentID:        le.forcedAgentID,
			CallerTools:          le.callerTools,
			PriorCallerToolCalls: le.priorCallerCalls,
		})
	}, at)
}

// signalToolSuccess delivers a succeeded event for launch #launchIndex once
// that launch exists, rescheduling in virtual time until it does.
//
// Routed by the workflow id carried in the launch input, exactly as the
// gateway's callback bridge routes by the id baked into the callback URL. That
// matters because a tool call can belong to the conversation OR to a child
// agent workflow, and only the launch itself knows which.
func (le *loopEnv) signalToolSuccess(launchIndex int, resultJSON string) {
	var attempt func()
	attempt = func() {
		if len(le.launches) <= launchIndex {
			le.env.RegisterDelayedCallback(attempt, 100*time.Millisecond)
			return
		}
		launch := le.launches[launchIndex]
		_ = le.env.SignalWorkflowByID(launch.WorkflowID,
			workflows.ToolEventSignalPrefix+launch.JobID, messaging.Event{
				JobID: launch.JobID, Seq: 1, TS: "t", Type: "succeeded", Result: json.RawMessage(resultJSON),
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

// A skill declaring agentRefs (ADR 0021): the recipes skill can also delegate
// to the meal-planner agent as one of its own "tools".
func recipesSkillToolsWithAgentRef() *activities.SkillTools {
	st := recipesSkillTools()
	st.Skill.AgentIDs = []string{"meal-planner"}
	st.Agents = []catalog.AgentDescriptor{mealPlannerAgent()}
	return st
}

// TS's loadSkillTools (graph.ts:1703-1758) adapts each resolved Agent into
// the same ToolDescriptor shape an agent-backed Tool already produces, and
// merges it into the candidate list the planner sees. Go's ResolveSkillTools
// populated SkillTools.Agents but the plan⇄runTool loop never passed it to
// the planner — dead data.
func TestSkillAgentRefsReachThePlanner(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillToolsWithAgentRef()
	le.plans = []activities.PlannedAction{{Action: activities.ActionRespond, Response: "ok"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "plan my meals", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.NotEmpty(t, le.planInputs)
	var found *catalog.ToolDescriptor
	for i, tool := range le.planInputs[0].Tools {
		if tool.ID == "meal-planner" {
			found = &le.planInputs[0].Tools[i]
		}
	}
	require.NotNil(t, found, "the skill's agentRefs must reach the planner's candidate list")
	require.Equal(t, "meal-planner", found.AgentRef, "adapted as an agent-backed tool, matching a Tool.spec.agentRef wrapper")
}

// TS's runTool branches on `tool.agentRunTemplate` (graph.ts:1845-1910) to
// dispatch an agent-backed Tool as an AgentRun over the same bridge
// peer-level delegation uses, instead of a ToolRun Job. Go's ResolveSkillTools
// resolves the marker (ToolDescriptor.AgentRef) but the skill-tool dispatch
// path never branched on it — every planner-picked tool went through the
// container ToolRun path unconditionally, a real runtime failure against a
// target that isn't a Job template.
func TestAgentBackedSkillToolDispatchesAsAnAgentRunNotAJob(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillToolsWithAgentRef()
	le.resolvedAgent = func() *catalog.AgentDescriptor { a := mealPlannerAgent(); return &a }()
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "meal-planner", ToolInput: "plan five days of meals"},
	}
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionFinish, Message: "Planned five days of meals."},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "plan my meals", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Empty(t, le.launches, "an agent-backed tool must never launch a container Job")
	require.Equal(t, []string{"meal-planner"}, result.Meta.ToolCalls)
	require.Contains(t, result.Reply, "Planned five days of meals.")
}

// TS scopes a tool's continuation token to `${tool.id}::${toolInstanceKey}`
// (ADR 0017) so two instances of the same multi-instance tool in one
// conversation don't clobber each other's saved state. Go keyed
// ToolContinuations by bare toolID only.
func TestToolInstanceKeyScopesContinuationSeparately(t *testing.T) {
	le := newLoopEnv(t)
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.selected = "recipes"
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/pasta", ToolInstanceKey: "pasta"},
		{Action: activities.ActionFinish},
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "https://example.com/soup", ToolInstanceKey: "soup"},
		{Action: activities.ActionFinish},
		// Turn 3 resumes the "pasta" instance — must see tok-pasta, not tok-soup.
		{Action: activities.ActionCallTool, ToolID: "recipe-scraper", ToolInput: "publish it", ToolInstanceKey: "pasta"},
		{Action: activities.ActionFinish},
	}

	var first, second, third workflows.TurnResult
	le.sendTurn(t, "turn-1", "grab the pasta recipe", &first, time.Millisecond)
	le.env.RegisterDelayedCallback(func() {
		le.signalToolSuccess(0, `"<!-- continuation: tok-pasta -->\n\nPasta page"`)
	}, time.Second)

	le.sendTurn(t, "turn-2", "grab the soup recipe too", &second, 2*time.Second)
	le.env.RegisterDelayedCallback(func() {
		le.signalToolSuccess(1, `"<!-- continuation: tok-soup -->\n\nSoup page"`)
	}, 3*time.Second)

	le.sendTurn(t, "turn-3", "now publish the pasta one", &third, 4*time.Second)
	le.env.RegisterDelayedCallback(func() {
		le.signalToolSuccess(2, `"published"`)
	}, 5*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "<!-- continuation: tok-pasta -->\n\npublish it", le.launches[2].Args[0],
		"turn 3 must resume the pasta instance's token, not soup's")
}

// TS unions LocalTool CRs into the same tool catalog (docs/adr/0014) and
// branches runTool on `tool.localExec`, dispatching to the executor sidecar
// instead of a k8s Job. Go had no LocalTool concept at all.
func TestLocalToolDispatchesViaTheExecutorNotAJob(t *testing.T) {
	le := newLoopEnv(t)
	skillTools := recipesSkillTools()
	skillTools.Tools = append(skillTools.Tools, catalog.ToolDescriptor{
		ID: "http-get-node", Description: "fetch a URL", AllowedRoles: []string{"cook"},
		LocalExec: &catalog.LocalExecSpec{Runtime: "node", Package: "p", Version: "1.0.0"},
	})
	le.skills = []catalog.SkillDescriptor{skillTools.Skill}
	le.selected = "recipes"
	le.skillTools = skillTools
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "http-get-node", ToolInput: "https://example.com"},
		{Action: activities.ActionFinish},
	}
	le.runLocalToolResult = &messaging.Event{Type: messaging.EventSucceeded, Result: []byte(`"fetched"`)}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "fetch https://example.com", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Empty(t, le.launches, "a LocalTool must never launch a container Job")
	require.Len(t, le.runLocalToolInputs, 1)
	require.Equal(t, "http-get-node", le.runLocalToolInputs[0].Tool.ID)
	require.Equal(t, "https://example.com", le.runLocalToolInputs[0].Input)
	require.Contains(t, result.Reply, "fetched")
}

func mealPlannerAgent() catalog.AgentDescriptor {
	return catalog.AgentDescriptor{
		ID:          "meal-planner",
		Description: "plans meals for the week",
		AgentPrompt: "You are a meal planner.",
		SkillRefs:   []string{"recipes"},
	}
}

// TS always defaults identity-link flow to "authcode", overridable per-request
// (server.ts:713-714) — a headless caller with no browser to redirect can ask
// for "device" instead. Go instead INFERRED flow from Live (device if not
// live, authcode if live), conflating "can this turn wait live" with "which
// OAuth flow to start": any non-live turn got a device-code flow with no way
// to ask for authcode, and a live turn could never get device either.
func TestIdentityLinkFlowDefaultsToAuthcodeRegardlessOfLive(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{{Action: activities.AgentActionFinish, Message: "done"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "help me plan meals", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.NotEmpty(t, le.authorizeInputs)
	require.Equal(t, "authcode", le.authorizeInputs[0].Flow, "a non-live (fire-and-forget) turn must still default to authcode")
}

func TestIdentityLinkFlowOverrideRequestsDevice(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{{Action: activities.AgentActionFinish, Message: "done"}}

	var result workflows.TurnResult
	le.env.RegisterDelayedCallback(func() {
		le.env.UpdateWorkflow(workflows.UserTurnUpdate, "turn-1", &testsuite.TestUpdateCallback{
			OnAccept: func() {},
			OnReject: func(err error) { t.Errorf("update rejected: %v", err) },
			OnComplete: func(success interface{}, err error) {
				require.NoError(t, err)
				if v, ok := success.(workflows.TurnResult); ok {
					result = v
				}
			},
		}, workflows.TurnInput{
			Message:          "help me plan meals",
			Caller:           activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
			IdentityLinkFlow: "device",
		})
	}, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.NotEmpty(t, le.authorizeInputs)
	require.Equal(t, "device", le.authorizeInputs[0].Flow)
	require.Equal(t, "done", result.Reply)
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

// A turn that stopped for an account link must resume by re-checking the
// EXACT flow it already started, not by starting a second one. Before the
// fix, every resume ran Authorize fresh with no memory of the outstanding
// anchor, so a still-pending flow looked identical to a never-started one and
// got a brand-new device code each time — the caller's in-progress code was
// silently orphaned on every "send any message once you're done".
func TestPendingLinkResumeReChecksTheSameFlowInsteadOfStartingAnother(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools() // the child resolves its skillRefs
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionFinish, Message: "Planned five days of meals."},
	}
	// resumePendingLink re-resolves the anchor's agent under current roles
	// before retrying it.
	le.resolvedAgent = &agent

	firstAnchor := &authz.PendingLink{
		AgentID:    agent.ID,
		Provider:   "github",
		Flow:       "device",
		DeviceCode: "device-1",
		Subject:    "user:1",
		ExpiresAt:  time.Now().Add(time.Hour).UnixMilli(),
		LinkText:   "[link your GitHub account](https://github.com/login/device) and enter code `ABCD-1234`",
	}
	calls := 0
	le.authorizeVerdict = func() authz.Verdict {
		calls++
		if calls == 1 {
			return authz.Verdict{
				Kind: authz.KindLinkRequired,
				Message: "To continue, please " + firstAnchor.LinkText +
					". This is a one-time step -- send any message once you're done.",
				Pending: firstAnchor,
			}
		}
		return authz.Verdict{Kind: authz.KindAuthorized}
	}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "help me plan meals for the week", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "done", &second, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "link-required", first.Meta.Path)
	require.Contains(t, first.Reply, "ABCD-1234")

	require.Len(t, le.authorizeInputs, 2)
	require.NotNil(t, le.authorizeInputs[1].Pending,
		"the resume must carry the first turn's anchor so Authorize can re-check it instead of starting a second flow")
	require.Equal(t, "device-1", le.authorizeInputs[1].Pending.DeviceCode,
		"the resume must re-check the SAME device code, not one from a fresh Start")

	require.Equal(t, "Planned five days of meals.", second.Reply)
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
	// TS's composeResponse no-ops without a selectedSkill, which the fallback
	// path never sets (graph.ts:2058) — no narration prefix/suffix, ever.
	require.Equal(t, "pod-a  Running"+workflows.SelfImprovementFooter, result.Reply)
	require.Zero(t, le.composeCalls, "the fallback-tool path must never compose narration around a raw result")
	// Two fit checks now: once when the tool is offered to the combined
	// delegate selector (ADR 0037), and once more in noMatchFallback's own
	// independent selectFallbackTool safety net after the selector picks none.
	require.Equal(t, 2, le.toolFitCalls)
}

// TS's selectFallbackTool (graph.ts:1162-1196) appends state.callerTools to
// the fallback candidate list, unfiltered by the fit check (a caller tool was
// already relevance-ranked by supplying it for this conversation). No skill
// matched here, so a caller who supplies a tool for exactly this kind of
// request must still be offered it.
func TestNoMatchFallbackOffersACallerSuppliedTool(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = ""
	// No catalog tool anywhere near this request.
	le.catalogTools = nil
	le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "caller:web_search", ToolInput: `{"query":"carbonara"}`},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "look up a carbonara recipe", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Len(t, result.PendingToolCalls, 1)
	require.Equal(t, "web_search", result.PendingToolCalls[0].Name)
	require.Empty(t, le.launches, "a caller tool is never launched by this system")
	require.NotEmpty(t, le.planInputs)
	require.Equal(t, le.callerTools, le.planInputs[0].CallerTools, "caller tools reach the fallback planner unfiltered by fit-check")
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

	// Fit-checked once when offered to the combined selector and once again in
	// the fallback safety net — a loose keyword match is rejected at both.
	require.Equal(t, 2, le.toolFitCalls)
	require.Zero(t, le.selectDelegateCalls, "no fitting tool and no agent — the combined selector is never consulted")
	require.Zero(t, le.planCalls, "a rejected candidate must never reach the planner")
	require.Equal(t, "fallback-bare", result.Meta.Path)
	require.Equal(t, "bare answer"+workflows.SelfImprovementFooter, result.Reply)
	require.Empty(t, le.launches, "nothing should have been launched")
}

// ADR 0037: a bare tool that the combined selector picks over a competing
// agent is a FIRST-CLASS match — it runs directly (meta.Path "tool"), the
// agent is never launched, and the reply carries NO self-improvement footer
// (nothing "went unmatched" — the tool was the deliberate choice).
func TestBareToolWinsCombinedDelegateSelectionOverAnAgent(t *testing.T) {
	le := newLoopEnv(t)
	le.agents = []catalog.AgentDescriptor{mealPlannerAgent()} // a broad agent also on the table
	le.catalogTools = []catalog.ToolDescriptor{kubectlTool()}
	le.toolFits = true
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateTool, ID: "kubectl-readonly"}
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "kubectl-readonly", ToolInput: "get pods -n default"},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "what pods are running?", &result, time.Millisecond)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"pod-a  Running"`) }, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "tool", result.Meta.Path)
	require.Equal(t, []string{"kubectl-readonly"}, result.Meta.ToolCalls)
	// TS's composeResponse no-ops without a selectedSkill, which a first-class
	// tool selection never sets (graph.ts:2058) — no narration prefix/suffix.
	require.Equal(t, "pod-a  Running", result.Reply)
	require.Zero(t, le.composeCalls, "a first-class tool selection must never compose narration around a raw result")
	require.NotContains(t, result.Reply, workflows.SelfImprovementFooter,
		"a deliberately selected tool is not an ad-hoc no-match fallback")
	require.Zero(t, le.agentPlanCalls, "the competing agent's episode must never start")
	// The tool was offered to the selector alongside the agent — not starved
	// out to the fallback path the way it was before ADR 0037.
	require.Len(t, le.selectDelegateInputs, 1)
	require.Len(t, le.selectDelegateInputs[0].Tools, 1)
	require.Equal(t, "kubectl-readonly", le.selectDelegateInputs[0].Tools[0].ID)
}

// A retrieved tool that fails the CheckToolFit relevance gate must not be
// among the candidates offered to the combined selector (ADR 0037) — the gate
// is what keeps a loose embedding match from competing at all.
func TestToolFailingFitCheckIsNotOfferedToDelegateSelector(t *testing.T) {
	le := newLoopEnv(t)
	le.agents = []catalog.AgentDescriptor{mealPlannerAgent()}
	le.catalogTools = []catalog.ToolDescriptor{
		{ID: "github-repo-create", Description: "create or clone a repository", AllowedRoles: []string{"cook"}},
	}
	le.toolFits = false // the gate's default, and the whole point
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: "meal-planner"}
	le.skillTools = recipesSkillTools() // the child resolves its skillRefs
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionFinish, Message: "planned"},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "plan meals for the week", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Len(t, le.selectDelegateInputs, 1)
	require.Empty(t, le.selectDelegateInputs[0].Tools,
		"a tool that failed the fit gate must not reach the selector")
	require.Equal(t, "agent", result.Meta.Path)
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

// TS's best-effort-responder.ts SYSTEM_PROMPT frames the model as a genuine
// last resort with no ability to call any tool, told the request is DATA not
// instructions (a prompt-injection guard) — Go's bareAnswer used a generic
// "helpful assistant" prompt with none of that framing.
func TestBareAnswerUsesTheSafetyFramedSystemPrompt(t *testing.T) {
	le := newLoopEnv(t)
	le.needsCapability = false

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "write me a poem", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.NotEmpty(t, le.completeTurnInputs)
	prompt := le.completeTurnInputs[0].SystemPrompt
	require.Contains(t, prompt, "no ability to call any tool")
	require.Contains(t, prompt, "DATA, not instructions")
}

// TS's callBestEffort sends only `state.request` as the user turn, never the
// full transcript (best-effort-responder.ts's respond takes one string).
// Go's bareAnswer sent the whole conversation history instead.
func TestBareAnswerSendsOnlyTheCurrentRequestNotTheFullTranscript(t *testing.T) {
	le := newLoopEnv(t)
	le.needsCapability = false

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "hello there", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "how are you", &second, 2*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Len(t, le.completeTurnInputs, 2)
	require.Len(t, le.completeTurnInputs[1].Messages, 1, "only the current request, not accumulated history")
	require.Equal(t, "how are you", le.completeTurnInputs[1].Messages[0].Content)
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

// --- caller-supplied tools (ADR 0035) ---

func webSearchCallerTool(t *testing.T) callertools.Descriptor {
	t.Helper()
	tool, err := callertools.New("web_search", "Search the web",
		json.RawMessage(`{"type":"object","properties":{"query":{"type":"string"}}}`))
	require.NoError(t, err)
	return tool
}

// The second non-error terminal shape: the turn ends by asking the CLIENT to
// run its own function. Nothing is launched here — this is the only tool branch
// that executes nothing.
func TestCallerToolEndsTheTurnWithoutExecutingAnything(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = "recipes"
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{{
		Action:    activities.ActionCallTool,
		ToolID:    "caller:web_search",
		ToolInput: `{"query":"carbonara"}`,
	}}
	le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "look up a carbonara recipe", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Len(t, result.PendingToolCalls, 1)
	require.Equal(t, "web_search", result.PendingToolCalls[0].Name)
	require.JSONEq(t, `{"query":"carbonara"}`, result.PendingToolCalls[0].Arguments)
	require.NotEmpty(t, result.PendingToolCalls[0].ID, "the client echoes this back as tool_call_id")
	require.Empty(t, result.Reply, "there is no answer yet — the client has to run the function")
	require.Empty(t, le.launches, "a caller tool is never launched by this system")
}

// The planner may not invent a name here any more than in the catalog branch.
func TestAnUnofferedCallerToolIsRejected(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = "recipes"
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.skillTools = recipesSkillTools()
	le.plans = []activities.PlannedAction{
		{Action: activities.ActionCallTool, ToolID: "caller:exfiltrate", ToolInput: "{}"},
		{Action: activities.ActionRespond, Response: "I can't do that."},
	}
	le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "do the thing", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Empty(t, result.PendingToolCalls)
	require.Equal(t, "I can't do that.", result.Reply)
}

// nil means ALLOWED; an authored skill can opt out. Not an authorization
// boundary — it keeps a skill's tool loop predictable, nothing more.
func TestSkillCanRefuseCallerTools(t *testing.T) {
	refuse := false
	skillTools := recipesSkillTools()
	skillTools.Skill.AllowCallerTools = &refuse

	le := newLoopEnv(t)
	le.selected = "recipes"
	le.skills = []catalog.SkillDescriptor{skillTools.Skill}
	le.skillTools = skillTools
	le.plans = []activities.PlannedAction{{Action: activities.ActionRespond, Response: "no tools for you"}}
	le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "search for something", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.NotEmpty(t, le.planInputs)
	require.Empty(t, le.planInputs[0].CallerTools, "a refusing skill offers the planner none")
}

// TS's callerToolArguments (graph.ts:805-820) validates a caller tool's
// arguments as a JSON object before handing them back to the client, and a
// malformed value ENDS THE TURN WITH AN ERROR rather than being forwarded
// verbatim — a caller tool call whose arguments don't match its own schema
// produces a confusing client-side failure instead of surfacing the real
// cause here.
func TestCallerToolMalformedArgumentsFailsTheTurn(t *testing.T) {
	cases := []struct {
		name  string
		input string
	}{
		{"not JSON at all", "not json"},
		{"a JSON array", `["query","carbonara"]`},
		{"a JSON string", `"carbonara"`},
		{"a JSON number", `42`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			le := newLoopEnv(t)
			le.selected = "recipes"
			le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
			le.skillTools = recipesSkillTools()
			le.plans = []activities.PlannedAction{{
				Action:    activities.ActionCallTool,
				ToolID:    "caller:web_search",
				ToolInput: c.input,
			}}
			le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}

			var updateErr error
			le.env.RegisterDelayedCallback(func() {
				le.env.UpdateWorkflow(workflows.UserTurnUpdate, "turn-1", &testsuite.TestUpdateCallback{
					OnAccept:   func() {},
					OnReject:   func(err error) { updateErr = err },
					OnComplete: func(success interface{}, err error) { updateErr = err },
				}, workflows.TurnInput{
					Message:     "look up a carbonara recipe",
					Caller:      activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
					CallerTools: le.callerTools,
				})
			}, time.Millisecond)

			le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
			require.True(t, le.env.IsWorkflowCompleted())
			require.Error(t, updateErr)
			require.ErrorContains(t, updateErr, "JSON object")
			require.Empty(t, le.launches, "a caller tool is never launched by this system")
		})
	}
}

// A resumed turn's prior result lives ONLY in the seeded history — no runTool
// ran this invocation. tool_choice "required", re-applied on the resend, is
// exactly what pushes the planner to re-issue the byte-identical call that hits
// the duplicate guard; without carrying the seeded result the facade renders
// nothing.
func TestResumedCallerToolTurnCarriesTheSeededResult(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = "recipes"
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.skillTools = recipesSkillTools()
	le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}
	// The planner re-issues the call it already made.
	le.plans = []activities.PlannedAction{{
		Action:    activities.ActionCallTool,
		ToolID:    "caller:web_search",
		ToolInput: `{"query":"carbonara"}`,
	}}
	le.priorCallerCalls = []callertools.PriorCall{{
		ID: "call_1", Name: "web_search",
		Arguments: `{"query":"carbonara"}`,
		Result:    "Classic carbonara: eggs, pecorino, guanciale.",
	}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "look up a carbonara recipe", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Classic carbonara: eggs, pecorino, guanciale.", result.Reply)
	require.Empty(t, result.PendingToolCalls, "the identical re-issue must not ask the client again")
}

// Seeding history also bounds the loop: the step cap counts history length, so
// a client cannot drive an unbounded planner loop by resending a longer
// conversation.
func TestSeededHistoryBoundsTheResumedLoop(t *testing.T) {
	le := newLoopEnv(t)
	le.selected = "recipes"
	le.skills = []catalog.SkillDescriptor{recipesSkillTools().Skill}
	le.skillTools = recipesSkillTools()
	le.callerTools = []callertools.Descriptor{webSearchCallerTool(t)}

	// Already at the step cap.
	for i := 0; i < 4; i++ {
		le.priorCallerCalls = append(le.priorCallerCalls, callertools.PriorCall{
			ID: "c" + string(rune('1'+i)), Name: "web_search",
			Arguments: `{"query":"q"}`, Result: "result " + string(rune('1'+i)),
		})
	}
	le.plans = []activities.PlannedAction{{
		Action: activities.ActionCallTool, ToolID: "caller:web_search", ToolInput: `{"query":"again"}`,
	}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "keep going", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Zero(t, le.planCalls, "at the cap the planner is not consulted at all")
	require.Empty(t, result.PendingToolCalls)
}

// --- an agent's own declared tools (ADR 0028) ---

// Cheap here by construction: upstream needs a tool_call/tool_result NATS pair,
// a callId-keyed pending map, an SDK method and a duplicated dispatch path,
// because its sub-agent is a separate process. A child workflow just calls
// runTool.
func TestAgentCallsItsOwnDeclaredTool(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.SkillRefs = nil // nothing from skills — the toolRef is the only source
	agent.ToolRefs = []string{"kubectl-readonly"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.agentTools = []catalog.ToolDescriptor{kubectlTool()}
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionCallTool, ToolID: "kubectl-readonly", ToolInput: "get pods"},
		{Action: activities.AgentActionFinish, Message: "Three pods, all Running."},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "what's running in the cluster?", &result, time.Millisecond)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"pod-a Running"`) }, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Three pods, all Running.", result.Reply)
	require.Len(t, le.launches, 1)
	require.Equal(t, "kubectl-readonly", le.launches[0].ToolRef)

	// The declared tool was offered to the agent's planner.
	require.NotEmpty(t, le.agentPlanInputs)
	require.Len(t, le.agentPlanInputs[0].Tools, 1)
	require.Equal(t, "kubectl-readonly", le.agentPlanInputs[0].Tools[0].ID)

	// And its result reached the agent's own history.
	require.Len(t, le.agentPlanInputs[1].History, 1)
	require.Equal(t, "pod-a Running", le.agentPlanInputs[1].History[0].Result)
}

// A tool the agent was never offered must not run, exactly as in the parent's
// loop — an id from the planner is never trusted on its own.
func TestAgentCannotCallAnUndeclaredTool(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.SkillRefs = nil
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.agentTools = nil // declares nothing
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionCallTool, ToolID: "kubectl-readonly", ToolInput: "delete everything"},
		{Action: activities.AgentActionFinish, Message: "I can't do that."},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "wipe the cluster", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Empty(t, le.launches, "an undeclared tool is never launched")
	require.Equal(t, "I can't do that.", result.Reply)
}

// A declared tool that requires a linked identity must not run credential-less
// from a sub-agent either. Upstream's sub-agent dispatch path skips this check,
// so a Tool meant to act as a specific human would fall back to whatever static
// token its template carries.
func TestAgentDeclaredToolStillPassesTheIdentityGate(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.SkillRefs = nil
	agent.ToolRefs = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.agentTools = []catalog.ToolDescriptor{{
		ID: "github", Description: "run a gh command", IdentityProviders: []string{"github"},
	}}
	le.toolCredentialVerdict = func() authz.Verdict {
		return authz.Verdict{Kind: authz.KindLinkRequired, Message: "please link your GitHub account"}
	}
	le.agentPlans = []activities.PlannedAgentAction{
		{Action: activities.AgentActionCallTool, ToolID: "github", ToolInput: "pr list"},
		{Action: activities.AgentActionFinish, Message: "I need your GitHub account linked."},
	}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "list my PRs", &result, time.Millisecond)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Empty(t, le.launches, "fail closed: no credential, no launch")
	require.Len(t, le.toolCredentialInputs, 1)
	require.Equal(t, "github", le.toolCredentialInputs[0].Tool.ID)
	// The refusal reached the agent's planner as a failed step, so it can react.
	require.Len(t, le.agentPlanInputs[1].History, 1)
	require.Contains(t, le.agentPlanInputs[1].History[0].Error, "link your GitHub")
}
