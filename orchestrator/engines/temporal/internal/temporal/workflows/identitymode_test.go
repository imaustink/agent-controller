package workflows_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/workflow"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/activities"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/workflows"
)

// Every agent launch now runs the pre-flight (docs/adr/0049), even for an
// agent that declares no identity providers, so its identity mode is resolved
// and its decision is on the audit record. The Agent's identity declarations
// and the turn's trigger reach the activity.
func TestEveryAgentLaunchRunsThePreflightWithItsIdentityMode(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.IdentityProviders = nil
	agent.DefaultIdentity = "agent"
	agent.AllowedIdentities = []string{"agent", "hybrid"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{{Action: activities.AgentActionFinish, Message: "done"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "help me plan meals", &result, time.Millisecond)
	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Len(t, le.authorizeInputs, 1, "an agent with no providers is still authorized, and recorded")
	in := le.authorizeInputs[0]
	require.Equal(t, "agent", in.DefaultIdentity)
	require.Equal(t, []string{"agent", "hybrid"}, in.AllowedIdentities)
}

// A conversation started before this change replays its history on the new
// code. There, an agent with no providers never ran the pre-flight, so the
// replay must not schedule it either, or the workflow wedges on a
// nondeterminism error.
func TestThePreflightForAProviderlessAgentIsVersioned(t *testing.T) {
	le := newLoopEnv(t)
	le.env.OnGetVersion("identity-mode-preflight", workflow.DefaultVersion, 1).Return(workflow.DefaultVersion)
	agent := mealPlannerAgent()
	agent.IdentityProviders = nil
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{{Action: activities.AgentActionFinish, Message: "done"}}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "help me plan meals", &result, time.Millisecond)
	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())
	require.Empty(t, le.authorizeInputs, "pre-change history never ran the pre-flight for a providerless agent")
}

// docs/adr/0049: a trigger's identity override reaches the pre-flight, and a
// turn parked on a link resumes under the SAME override even when the turn
// that notices the link landed carries none -- otherwise a delegated trigger's
// request could come back as an agent-mode one.
func TestTheTriggersIdentityOverrideReachesThePreflightAndSurvivesAResume(t *testing.T) {
	le := newLoopEnv(t)
	agent := mealPlannerAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.skillTools = recipesSkillTools()
	le.agentPlans = []activities.PlannedAgentAction{{Action: activities.AgentActionFinish, Message: "done"}}
	le.resolvedAgent = &agent

	calls := 0
	le.authorizeVerdict = func() authz.Verdict {
		calls++
		if calls == 1 {
			return authz.Verdict{Kind: authz.KindLinkRequired, Message: "link GitHub", Pending: &authz.PendingLink{
				AgentID: agent.ID, Provider: "github", Flow: "authcode", Subject: "user:1",
				ExpiresAt: time.Now().Add(time.Hour).UnixMilli(),
			}}
		}
		return authz.Verdict{Kind: authz.KindAuthorized}
	}

	caller := activities.Caller{Subject: "user:1", Roles: []string{"cook"}}
	var first, second workflows.TurnResult
	le.sendTurnInput(t, "turn-1", workflows.TurnInput{
		Message: "plan meals", Caller: caller, ForcedAgentID: agent.ID, IdentityOverride: "delegated",
	}, &first, time.Millisecond)
	le.sendTurnInput(t, "turn-2", workflows.TurnInput{Message: "linked it", Caller: caller}, &second, time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Len(t, le.authorizeInputs, 2)
	require.Equal(t, "delegated", le.authorizeInputs[0].IdentityOverride)
	require.Equal(t, "delegated", le.authorizeInputs[1].IdentityOverride, "the resume keeps the parked turn's override")
}
