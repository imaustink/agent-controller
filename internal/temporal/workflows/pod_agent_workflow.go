package workflows

import (
	"fmt"
	"time"

	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/continuation"
	"durable-agents/internal/messaging"
	"durable-agents/internal/temporal/activities"
)

// PodAgentWorkflow is the checkpoint-resume adapter for heavyweight pod
// agents (opencode-swe-agent): each work step runs the agent's step Tool as
// a one-shot Job carrying the episode's continuation token; a step that
// needs the human returns a question envelope and EXITS, and this workflow
// does the durable waiting — then launches a fresh Job with the answer.
// Upstream kept the pod alive on a NATS socket for this; here nothing runs
// while the human thinks.
const PodAgentWorkflowName = "PodAgentWorkflow"

const (
	// podStepTimeoutSeconds bounds one step Job (coding steps are long).
	podStepTimeoutSeconds = 1800
	defaultMaxPodSteps    = 8
)

func PodAgentWorkflow(ctx workflow.Context, in AgentWorkflowInput) error {
	logger := workflow.GetLogger(ctx)
	selfID := workflow.GetInfo(ctx).WorkflowExecution.ID

	up := func(u AgentUp) {
		if err := workflow.SignalExternalWorkflow(ctx, in.ParentWorkflowID, "", AgentUpSignalPrefix+selfID, u).Get(ctx, nil); err != nil {
			logger.Warn("up-signal to parent failed", "parent", in.ParentWorkflowID, "error", err)
		}
	}
	fail := func(code, message string) error {
		up(AgentUp{Failed: true, Code: code, Message: message})
		return fmt.Errorf("%s: %s", code, message)
	}

	if in.Agent.StepToolRef == "" {
		return fail("config_error", "pod agent "+in.Agent.ID+" has no step tool annotation")
	}

	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	prompts := workflow.GetSignalChannel(ctx, AgentPromptSignal)

	// Identity gate (ADR 0022 mechanics): agents acting as the caller need
	// the caller's own linked credential. Not linked → tell the human where
	// to link and durably wait; every reply re-checks (fail closed).
	for len(in.Agent.IdentityProviders) > 0 {
		var status activities.IdentityLinkStatus
		if err := workflow.ExecuteActivity(actx, activities.GetIdentityLinkActivityName, activities.IdentityLinkInput{
			Caller:    in.Caller,
			Providers: in.Agent.IdentityProviders,
		}).Get(ctx, &status); err != nil {
			return fail("identity_check_error", err.Error())
		}
		if status.Linked {
			break
		}
		up(AgentUp{Message: fmt.Sprintf(
			"I need access to your %s account first. Link it here: %s — then reply here and I'll continue.",
			status.MissingProvider, status.LinkURL)})
		var answer AgentPrompt
		prompts.Receive(ctx, &answer)
	}

	// The parent delivers prior-episode state as a leading marker on the
	// goal; from here the token lives in workflow state only.
	token, goal := continuation.Extract(in.Goal)
	stepInput := goal

	maxSteps := int(in.Agent.MaxIterations)
	if maxSteps <= 0 {
		maxSteps = defaultMaxPodSteps
	}

	for step := 0; step < maxSteps; step++ {
		arg := stepInput
		if token != "" {
			arg = continuation.Prepend(token, arg)
		}

		up(AgentUp{Progress: true, Message: fmt.Sprintf("Running %s (step %d)…", in.Agent.StepToolRef, step+1)})
		outcome, err := runTool(ctx, RunToolParams{
			ToolRef:        in.Agent.StepToolRef,
			Args:           []string{arg},
			TimeoutSeconds: podStepTimeoutSeconds,
			OnProgress: func(e messaging.Event) {
				line := e.Message
				if e.Stage != "" {
					line = e.Stage + ": " + line
				}
				up(AgentUp{Progress: true, Message: line})
			},
		})
		if err != nil {
			return fail("step_launch_error", err.Error())
		}
		if !outcome.Succeeded {
			return fail(outcome.ErrorCode, outcome.ErrorMessage)
		}

		envelope := messaging.ParseAgentStepResult(outcome.RawResult)
		if envelope.Continuation != "" {
			token = envelope.Continuation
		}
		if envelope.Status == messaging.StepFinal {
			up(AgentUp{Final: true, Message: envelope.Message, Result: token})
			return nil
		}

		// Question checkpoint: the Job has already exited; wait durably.
		up(AgentUp{Message: envelope.Message})
		var answer AgentPrompt
		prompts.Receive(ctx, &answer)
		stepInput = answer.Message
	}

	up(AgentUp{Final: true, Message: "I ran out of steps before finishing.", Result: token})
	return nil
}
