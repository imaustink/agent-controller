package workflows_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/authz"
	"durable-agents/internal/catalog"
	"durable-agents/internal/messaging"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
)

func sweAgent() catalog.AgentDescriptor {
	return catalog.AgentDescriptor{
		ID:          "swe-helper",
		Description: "makes code changes on request",
		StepToolRef: "swe-step",
	}
}

// registerAuthorize adds the pre-flight to a loopEnv with a switchable linked
// state, and records what it was asked.
//
// The gate lives in the PARENT now, so what a test observes is the turn's own
// reply rather than an up-signal from a child that gave up.
func registerAuthorize(le *loopEnv, linked *bool) {
	le.authorizeVerdict = func() authz.Verdict {
		if *linked {
			return authz.Verdict{
				Kind:        authz.KindAuthorized,
				SecretName:  "run-creds-abc123",
				EnvVarNames: []string{"GITHUB_TOKEN"},
				Principal:   "github:imaustink",
			}
		}
		return authz.Verdict{
			Kind:    authz.KindLinkRequired,
			Message: "To continue, please [link your GitHub account](https://github.com/login/device) and enter code `ABCD-1234`. This is a one-time step.",
			Pending: &authz.PendingLink{
				AgentID:  "swe-helper",
				Provider: "github",
				Flow:     "device",
				Subject:  "user:1",
				// Comfortably beyond the virtual time these specs advance
				// through, so expiry never masks the behaviour under test.
				ExpiresAt: farFutureMillis,
			},
		}
	}
}

// farFutureMillis is a fixed instant well past any spec's virtual clock.
// Deliberately not time.Now()-relative: the test env runs on a virtual clock
// that can leap hours, and a wall-clock offset would make expiry a coin flip.
const farFutureMillis = 4102444800000 // 2100-01-01

// signalStepResult delivers a step Job's terminal event once that launch
// exists, rescheduling in virtual time until it does (activity completions
// run on real goroutines and can trail virtual-time callbacks).
func (le *loopEnv) signalStepResult(t *testing.T, launchIndex int, envelope messaging.AgentStepResult) {
	raw, err := json.Marshal(envelope)
	require.NoError(t, err)
	var attempt func()
	attempt = func() {
		if len(le.launches) <= launchIndex {
			le.env.RegisterDelayedCallback(attempt, 100*time.Millisecond)
			return
		}
		// The step Job belongs to the CHILD workflow — route by the workflow
		// id carried in the launch input, exactly as the gateway's callback
		// bridge does with the id baked into the callback URL.
		launch := le.launches[launchIndex]
		err = le.env.SignalWorkflowByID(launch.WorkflowID, workflows.ToolEventSignalPrefix+launch.JobID, messaging.Event{
			JobID: launch.JobID, Seq: 1, TS: "t", Type: "succeeded", Result: raw,
		})
		require.NoError(t, err)
	}
	attempt()
}

func TestPodAgentCheckpointResumeAcrossTurns(t *testing.T) {
	le := newLoopEnv(t)
	linked := true
	registerAuthorize(le, &linked)
	le.agents = []catalog.AgentDescriptor{sweAgent()}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: "swe-helper"}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "add retry logic to the fetcher", &first, time.Millisecond)

	// Step 1 Job checkpoints with a question + its resume token, then exits.
	le.env.RegisterDelayedCallback(func() {
		le.signalStepResult(t, 0, messaging.AgentStepResult{
			Status:       messaging.StepQuestion,
			Message:      "Should retries use exponential backoff or fixed delay?",
			Continuation: "repo:x;branch:feat-retry;session:s1",
		})
	}, time.Second)

	le.sendTurn(t, "turn-2", "exponential please", &second, 2*time.Second)

	// Step 2 Job finishes with an updated token.
	le.env.RegisterDelayedCallback(func() {
		le.signalStepResult(t, 1, messaging.AgentStepResult{
			Status:       messaging.StepFinal,
			Message:      "Done — opened PR #42 with exponential backoff.",
			Continuation: "repo:x;branch:feat-retry;pr:42;session:s1",
		})
	}, 3*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Should retries use exponential backoff or fixed delay?", first.Reply)
	require.Equal(t, "Done — opened PR #42 with exponential backoff.", second.Reply)

	// Two one-shot Jobs, both against the step tool.
	require.Len(t, le.launches, 2)
	require.Equal(t, "swe-step", le.launches[0].ToolRef)
	require.Equal(t, "swe-step", le.launches[1].ToolRef)

	// Step 1 carried the raw goal; step 2 carried the answer with step 1's
	// token re-injected as a leading marker — and no token in any reply.
	require.Equal(t, "add retry logic to the fetcher", le.launches[0].Args[0])
	require.Equal(t, "<!-- continuation: repo:x;branch:feat-retry;session:s1 -->\n\nexponential please", le.launches[1].Args[0])
	require.NotContains(t, first.Reply, "repo:x")
	require.NotContains(t, second.Reply, "repo:x")
}

func TestPodAgentIdentityGateBlocksUntilLinked(t *testing.T) {
	le := newLoopEnv(t)
	linked := false
	registerAuthorize(le, &linked)
	agent := sweAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.resolvedAgent = &agent // the resume re-resolves it under current roles
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: "swe-helper"}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "fix the bug in main.go", &first, time.Millisecond)

	// User links between turns; the next turn re-runs the pre-flight.
	le.env.RegisterDelayedCallback(func() { linked = true }, time.Second)
	le.sendTurn(t, "turn-2", "ok, linked it", &second, 2*time.Second)

	le.env.RegisterDelayedCallback(func() {
		le.signalStepResult(t, 0, messaging.AgentStepResult{
			Status:  messaging.StepFinal,
			Message: "Fixed.",
		})
	}, 3*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Contains(t, first.Reply, "github.com/login/device", "turn 1 must be the link instruction")
	require.Equal(t, "link-required", first.Meta.Path)
	require.Equal(t, "Fixed.", second.Reply)

	// Fail closed: no step Job ran before the credential existed.
	require.Len(t, le.launches, 1)

	// The resume carries the ORIGINAL goal. Without the pending anchor's
	// captured request the agent would be told to "ok, linked it".
	require.Equal(t, "fix the bug in main.go", le.launches[0].Args[0])

	// And the launch carries a credential REFERENCE, never a value.
	require.Equal(t, "run-creds-abc123", le.launches[0].CredentialSecretName)
	require.Equal(t, []string{"GITHUB_TOKEN"}, le.launches[0].CredentialEnvVars)
}

// Whether a link completed is read by re-running the pre-flight, never from
// the user's word for it — otherwise the gate is arguable.
func TestPodAgentIdentityGateIsNotSatisfiedByTheUserSayingSo(t *testing.T) {
	le := newLoopEnv(t)
	linked := false
	registerAuthorize(le, &linked)
	agent := sweAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.resolvedAgent = &agent
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: "swe-helper"}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "fix the bug in main.go", &first, time.Millisecond)
	le.sendTurn(t, "turn-2", "I definitely linked it, you can proceed now", &second, 2*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "link-required", second.Meta.Path)
	require.Empty(t, le.launches, "nothing may launch on the caller's assurance alone")
	require.Len(t, le.authorizeInputs, 2, "the pre-flight ran again rather than trusting the message")
}
