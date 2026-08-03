package workflows_test

import (
	"context"
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
)

func newTestEnv(t *testing.T, fakeLLM func(context.Context, activities.CompleteTurnInput) (string, error)) *testsuite.TestWorkflowEnvironment {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterWorkflowWithOptions(workflows.ConversationWorkflow, workflow.RegisterOptions{
		Name: workflows.ConversationWorkflowName,
	})
	env.RegisterActivityWithOptions(fakeLLM, activity.RegisterOptions{
		Name: activities.CompleteTurnActivityName,
	})
	// These tests exercise the bare-conversation path: the gate always says
	// no capabilities needed.
	env.RegisterActivityWithOptions(func(context.Context, string) (bool, error) {
		return false, nil
	}, activity.RegisterOptions{Name: activities.CheckNeedsCapabilityActivityName})
	return env
}

func TestConversationWorkflow_TurnThenIdleCompletion(t *testing.T) {
	var seen activities.CompleteTurnInput
	env := newTestEnv(t, func(_ context.Context, in activities.CompleteTurnInput) (string, error) {
		seen = in
		return "hello back", nil
	})

	var result workflows.TurnResult
	var updateErr error
	env.RegisterDelayedCallback(func() {
		env.UpdateWorkflow(workflows.UserTurnUpdate, "turn-1", &testsuite.TestUpdateCallback{
			OnAccept: func() {},
			OnReject: func(err error) { updateErr = err },
			OnComplete: func(success interface{}, err error) {
				if err != nil {
					updateErr = err
					return
				}
				switch v := success.(type) {
				case converter.EncodedValue:
					updateErr = v.Get(&result)
				case workflows.TurnResult:
					result = v
				default:
					updateErr = fmt.Errorf("unexpected update result type %T", success)
				}
			},
		}, workflows.TurnInput{
			Message:     "hi there",
			SeedHistory: []workflows.ChatMessage{{Role: "user", Content: "earlier"}, {Role: "assistant", Content: "context"}},
		})
	}, 0)

	env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))

	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError(), "workflow should complete cleanly after idle timeout")
	require.NoError(t, updateErr)

	require.Equal(t, "hello back", result.Reply)
	require.Equal(t, 1, result.Turn)

	// The fake LLM saw system prompt + seeded history + the new user turn.
	require.NotEmpty(t, seen.SystemPrompt)
	require.Len(t, seen.Messages, 3)
	require.Equal(t, "hi there", seen.Messages[2].Content)
}

func TestConversationWorkflow_ContinueAsNewAfterMaxTurns(t *testing.T) {
	env := newTestEnv(t, func(_ context.Context, in activities.CompleteTurnInput) (string, error) {
		return fmt.Sprintf("reply %d", len(in.Messages)), nil
	})

	// Fire more turns than one run allows; each at a distinct virtual time.
	for i := 0; i < 41; i++ {
		id := fmt.Sprintf("turn-%d", i)
		env.RegisterDelayedCallback(func() {
			env.UpdateWorkflow(workflows.UserTurnUpdate, id, &testsuite.TestUpdateCallback{
				OnAccept:   func() {},
				OnReject:   func(error) {},
				OnComplete: func(interface{}, error) {},
			}, workflows.TurnInput{Message: "again"})
		}, 0)
	}

	env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, env.IsWorkflowCompleted())

	err := env.GetWorkflowError()
	require.Error(t, err)
	require.True(t, workflow.IsContinueAsNewError(err), "expected continue-as-new, got: %v", err)
}
