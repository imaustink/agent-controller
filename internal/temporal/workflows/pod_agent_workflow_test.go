package workflows_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"

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

// registerIdentityLink adds the identity activity to a loopEnv with a
// switchable linked state.
func registerIdentityLink(le *loopEnv, linked *bool) {
	le.env.RegisterActivityWithOptions(func(_ context.Context, in activities.IdentityLinkInput) (activities.IdentityLinkStatus, error) {
		if *linked {
			return activities.IdentityLinkStatus{Linked: true}, nil
		}
		return activities.IdentityLinkStatus{MissingProvider: "github", LinkURL: "https://github.com/login/device"}, nil
	}, activity.RegisterOptions{Name: activities.GetIdentityLinkActivityName})
}

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
	registerIdentityLink(le, &linked)
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
	registerIdentityLink(le, &linked)
	agent := sweAgent()
	agent.IdentityProviders = []string{"github"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: "swe-helper"}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "fix the bug in main.go", &first, time.Millisecond)

	// User links between turns; their reply triggers a re-check.
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
	require.Equal(t, "Fixed.", second.Reply)

	// No step Job ran before the link existed (fail closed).
	require.Len(t, le.launches, 1)
	require.Equal(t, "fix the bug in main.go", le.launches[0].Args[0], "original goal survives the identity pause")
}
