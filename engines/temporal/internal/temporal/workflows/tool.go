package workflows

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/toolrun"
)

// ToolEventSignalPrefix + jobID is the signal channel the gateway's callback
// bridge delivers a tool Job's event stream on. Correlation is per-job so
// concurrent tool calls in one workflow can't cross-talk.
const ToolEventSignalPrefix = "tool-event::"

const (
	defaultToolTimeoutSeconds = 300 // controller's activeDeadlineSeconds default
	// toolTimeoutGrace covers scheduling + callback latency beyond the Job's
	// own deadline: a timed-out Job should emit `failed` first; the workflow
	// timer is the backstop, so it fires later.
	toolTimeoutGrace = 60 * time.Second
)

type RunToolParams struct {
	ToolRef        string
	Args           []string
	TimeoutSeconds int32
	// CredentialSecretName / CredentialEnvVars carry caller-scoped credentials
	// into the Job. A reference and key names only; the values are already in
	// the Secret and must never enter workflow state.
	CredentialSecretName string
	CredentialEnvVars    []string
	// OnJobID fires once the job id exists (before the launch activity), so
	// callers can expose it via queries while the tool is still running.
	// OnProgress observes progress/warning events. Both run in workflow
	// context: mutate workflow state only, no I/O.
	OnJobID    func(string)
	OnProgress func(messaging.Event)
}

// ToolOutcome is a completed tool call — including failures, which are
// results for the caller to reason about, not workflow errors.
type ToolOutcome struct {
	JobID        string                  `json:"jobId"`
	Succeeded    bool                    `json:"succeeded"`
	Result       string                  `json:"result,omitempty"`
	RawResult    json.RawMessage         `json:"rawResult,omitempty"`
	Artifacts    []messaging.ArtifactRef `json:"artifacts,omitempty"`
	ErrorCode    string                  `json:"errorCode,omitempty"`
	ErrorMessage string                  `json:"errorMessage,omitempty"`
}

// runTool executes one tool call durably: create the ToolRun CR (activity),
// then await the callback event stream as signals under a timer. If the
// stream never terminates, the ToolRun's mirrored Job phase is the backstop.
// Only infrastructure problems return an error; tool failure is an outcome.
func runTool(ctx workflow.Context, p RunToolParams) (ToolOutcome, error) {
	timeoutSeconds := p.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = defaultToolTimeoutSeconds
	}

	var jobID string
	if err := workflow.SideEffect(ctx, func(workflow.Context) any {
		return "run-" + uuid.NewString()
	}).Get(&jobID); err != nil {
		return ToolOutcome{}, err
	}
	if p.OnJobID != nil {
		p.OnJobID(jobID)
	}

	actx := workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 3},
	})
	err := workflow.ExecuteActivity(actx, activities.LaunchToolRunActivityName, activities.LaunchToolRunInput{
		JobID:                jobID,
		ToolRef:              p.ToolRef,
		Args:                 p.Args,
		WorkflowID:           workflow.GetInfo(ctx).WorkflowExecution.ID,
		TimeoutSeconds:       timeoutSeconds,
		CredentialSecretName: p.CredentialSecretName,
		CredentialEnvVars:    p.CredentialEnvVars,
	}).Get(ctx, nil)
	if err != nil {
		return ToolOutcome{}, fmt.Errorf("launch tool %s: %w", p.ToolRef, err)
	}

	outcome := ToolOutcome{JobID: jobID}
	events := workflow.GetSignalChannel(ctx, ToolEventSignalPrefix+jobID)
	timerCtx, cancelTimer := workflow.WithCancel(ctx)
	defer cancelTimer() // don't leave the timer pending in long-lived workflows
	timer := workflow.NewTimer(timerCtx, time.Duration(timeoutSeconds)*time.Second+toolTimeoutGrace)

	lastSeq := -1
	var terminal *messaging.Event
	timedOut := false
	for terminal == nil && !timedOut {
		selector := workflow.NewSelector(ctx)
		selector.AddReceive(events, func(c workflow.ReceiveChannel, _ bool) {
			var event messaging.Event
			c.Receive(ctx, &event)
			if event.Seq <= lastSeq {
				return // at-least-once delivery: drop replays
			}
			lastSeq = event.Seq
			switch event.Type {
			case messaging.EventProgress, messaging.EventWarning:
				if p.OnProgress != nil {
					p.OnProgress(event)
				}
			case messaging.EventSucceeded, messaging.EventFailed:
				terminal = &event
			}
		})
		selector.AddFuture(timer, func(workflow.Future) { timedOut = true })
		selector.Select(ctx)
	}

	if timedOut {
		// Crash backstop: the controller mirrors terminal Job state onto the
		// CR even when the tool never emitted a `failed` event.
		var status toolrun.Status
		if err := workflow.ExecuteActivity(actx, activities.GetToolRunPhaseActivityName, jobID).Get(ctx, &status); err != nil {
			status = toolrun.Status{Message: "phase check failed: " + err.Error()}
		}
		outcome.ErrorCode = "timeout"
		if status.Phase == toolrun.PhaseFailed {
			outcome.ErrorCode = "job_failed"
		}
		outcome.ErrorMessage = fmt.Sprintf(
			"no terminal event within %ds (ToolRun phase %q: %s)",
			timeoutSeconds, status.Phase, status.Message)
		return outcome, nil
	}

	if terminal.Type == messaging.EventSucceeded {
		outcome.Succeeded = true
		outcome.Result = terminal.ResultText()
		outcome.RawResult = terminal.Result
		outcome.Artifacts = terminal.Artifacts
	} else {
		outcome.ErrorCode = terminal.Code
		outcome.ErrorMessage = terminal.Message
	}
	return outcome, nil
}
