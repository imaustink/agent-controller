package workflows_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/agentrun"
	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
)

func bridgedAgent() catalog.AgentDescriptor {
	return catalog.AgentDescriptor{
		ID:          "claude-code-swe-agent",
		Description: "makes code changes on request",
		Bridged:     true,
	}
}

// deliverUp plays the agent's part once its AgentRun exists, rescheduling in
// virtual time until it does. Routed to the CHILD workflow, exactly as the real
// bridge routes by the workflow id it was attached with.
func (le *loopEnv) deliverUp(msg agentrun.UpMessage, at time.Duration) {
	var attempt func()
	attempt = func() {
		if len(le.agentRunLaunches) == 0 {
			le.env.RegisterDelayedCallback(attempt, 100*time.Millisecond)
			return
		}
		launch := le.agentRunLaunches[0]
		msg.AgentRunID = launch.RunID
		_ = le.env.SignalWorkflowByID(launch.WorkflowID, agentrun.UpSignalPrefix+launch.RunID, msg)
	}
	le.env.RegisterDelayedCallback(attempt, at)
}

// An unmodified upstream pod agent, launched as the AgentRun it always was,
// speaking the protocol it always spoke — with a workflow holding the durable
// half of the conversation instead of a pod that a deploy can take out.
func TestBridgedAgentRunsToAFinalReply(t *testing.T) {
	le := newLoopEnv(t)
	agent := bridgedAgent()
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "add retry logic to the fetcher", &result, time.Millisecond)

	le.deliverUp(agentrun.UpMessage{Seq: 1, Type: agentrun.UpReady}, time.Second)
	le.deliverUp(agentrun.UpMessage{Seq: 2, Type: agentrun.UpProgress, Stage: "clone", Message: "cloning the repo"}, 2*time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 3, Type: agentrun.UpReply, Final: true, Message: "Opened PR #42 with exponential backoff.",
	}, 3*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Opened PR #42 with exponential backoff.", result.Reply)
	require.Equal(t, "agent", result.Meta.Path)

	// One AgentRun, named so that the CR, the protocol's agent_run_id and the
	// NATS subjects all agree.
	require.Len(t, le.agentRunLaunches, 1)
	require.Equal(t, "claude-code-swe-agent", le.agentRunLaunches[0].AgentRef)
	require.Equal(t, "add retry logic to the fetcher", le.agentRunLaunches[0].Goal)
	// A prefix, not the full id: newAgentRunName truncates it to keep
	// "agentrun-<agentId>-<uuid>" within Kubernetes' 63-byte label limit, and
	// "claude-code-swe-agent" is already long enough that the full form (67
	// bytes) doesn't fit — see agentrun_name_test.go for the exact bound.
	require.Contains(t, le.agentRunLaunches[0].RunID, "claude-code-swe")
	require.LessOrEqual(t, len(le.agentRunLaunches[0].RunID), 63)

	// Narration reached the user.
	require.Contains(t, result.Meta.Narration, "clone: cloning the repo")

	// No ToolRun: the agent's own tools are its image's business.
	require.Empty(t, le.launches)
}

// HITL has no dedicated message pair: a question IS a non-final reply, and the
// answer arrives as the next prompt. Deliberately, because a human may answer
// across chat turns and no reply timeout can apply.
func TestBridgedAgentQuestionSpansTurns(t *testing.T) {
	le := newLoopEnv(t)
	agent := bridgedAgent()
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}

	var first, second workflows.TurnResult
	le.sendTurn(t, "turn-1", "fix the flaky test", &first, time.Millisecond)

	le.deliverUp(agentrun.UpMessage{Seq: 1, Type: agentrun.UpReady}, time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 2, Type: agentrun.UpReply, Final: false, Message: "Should I skip it or fix the race?",
	}, 2*time.Second)

	// The human answers on the NEXT chat turn; the agent is still running.
	le.sendTurn(t, "turn-2", "fix the race", &second, 4*time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 3, Type: agentrun.UpReply, Final: true, Message: "Fixed the race; PR #43.",
	}, 6*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "Should I skip it or fix the race?", first.Reply)
	require.Equal(t, "Fixed the race; PR #43.", second.Reply)
	require.Equal(t, "agent-continued", second.Meta.Path)

	// One AgentRun for the whole episode — the answer went down as a prompt
	// rather than starting a second run.
	require.Len(t, le.agentRunLaunches, 1)
	require.Contains(t, le.agentDownMessages, activities.AgentDownInput{
		RunID: le.agentRunLaunches[0].RunID, Type: agentrun.DownPrompt, Message: "fix the race",
	})
}

// A pod agent calling a Tool from its own toolRefs (ADR 0028) over the
// tool_call/tool_result pair. The dispatch is the ordinary one.
func TestBridgedAgentToolCall(t *testing.T) {
	le := newLoopEnv(t)
	agent := bridgedAgent()
	agent.ToolRefs = []string{"kubectl-readonly"}
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}
	le.agentTools = []catalog.ToolDescriptor{kubectlTool()}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "why is the deploy stuck?", &result, time.Millisecond)

	le.deliverUp(agentrun.UpMessage{Seq: 1, Type: agentrun.UpReady}, time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 2, Type: agentrun.UpToolCall, CallID: "call_1",
		Tool: "kubectl-readonly", Input: "get pods -n prod",
	}, 2*time.Second)
	le.env.RegisterDelayedCallback(func() { le.signalToolSuccess(0, `"pod-a CrashLoopBackOff"`) }, 3*time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 3, Type: agentrun.UpReply, Final: true, Message: "A pod is crash-looping.",
	}, 5*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Equal(t, "A pod is crash-looping.", result.Reply)
	require.Len(t, le.launches, 1)
	require.Equal(t, "kubectl-readonly", le.launches[0].ToolRef)

	// The result went back down on the correlated callId.
	var answered bool
	for _, down := range le.agentDownMessages {
		if down.Type == agentrun.DownToolResult && down.CallID == "call_1" {
			answered = true
			require.True(t, down.OK)
			require.Equal(t, "pod-a CrashLoopBackOff", down.Result)
		}
	}
	require.True(t, answered, "the agent must get its tool_result")
}

// A tool the operator never declared is refused on the wire rather than run.
// The CRD-level check upstream performs on toolRefs is a static-config sanity
// check; this is the boundary.
func TestBridgedAgentToolCallRefusesAnUndeclaredTool(t *testing.T) {
	le := newLoopEnv(t)
	agent := bridgedAgent() // declares no toolRefs
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "do the thing", &result, time.Millisecond)

	le.deliverUp(agentrun.UpMessage{Seq: 1, Type: agentrun.UpReady}, time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 2, Type: agentrun.UpToolCall, CallID: "call_1",
		Tool: "kubectl-readonly", Input: "delete everything",
	}, 2*time.Second)
	le.deliverUp(agentrun.UpMessage{
		Seq: 3, Type: agentrun.UpReply, Final: true, Message: "I couldn't do that.",
	}, 3*time.Second)

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Empty(t, le.launches, "an undeclared tool is never launched")

	var refused bool
	for _, down := range le.agentDownMessages {
		if down.Type == agentrun.DownToolResult && down.CallID == "call_1" {
			refused = true
			require.False(t, down.OK)
			require.Contains(t, down.Error, "not available")
		}
	}
	require.True(t, refused, "the agent gets a clean refusal, not silence")
}

// A pod that never becomes ready is an infrastructure problem — an image pull
// failure, a crash loop — and must surface in minutes rather than waiting out
// the full idle window.
func TestBridgedAgentNeverReadyFailsFast(t *testing.T) {
	le := newLoopEnv(t)
	agent := bridgedAgent()
	le.agents = []catalog.AgentDescriptor{agent}
	le.delegate = activities.DelegateChoice{Kind: activities.DelegateAgent, ID: agent.ID}

	var result workflows.TurnResult
	le.sendTurn(t, "turn-1", "do some work", &result, time.Millisecond)
	// Nothing is ever delivered.

	le.env.ExecuteWorkflow(workflows.ConversationWorkflowName, (*workflows.ConversationState)(nil))
	require.True(t, le.env.IsWorkflowCompleted())
	require.NoError(t, le.env.GetWorkflowError())

	require.Contains(t, result.Reply, "never became ready")

	// And it was told to stop, so the pod is not left running.
	var cancelled bool
	for _, down := range le.agentDownMessages {
		if down.Type == agentrun.DownCancel {
			cancelled = true
		}
	}
	require.True(t, cancelled)
}

// registerAgentRunActivities fakes the bridge's activity surface.
func registerAgentRunActivities(le *loopEnv) {
	reg := func(name string, fn any) {
		le.env.RegisterActivityWithOptions(fn, registerOpts(name))
	}
	reg(activities.LaunchAgentRunActivityName, func(_ context.Context, in activities.LaunchAgentRunInput) error {
		le.agentRunLaunches = append(le.agentRunLaunches, in)
		return nil
	})
	reg(activities.SendAgentDownActivityName, func(_ context.Context, in activities.AgentDownInput) error {
		le.agentDownMessages = append(le.agentDownMessages, in)
		return nil
	})
	reg(activities.GetAgentRunPhaseActivityName, func(context.Context, string) (any, error) {
		return map[string]any{"phase": "Running"}, nil
	})
	reg(activities.DetachAgentRunActivityName, func(context.Context, string) error { return nil })
}
