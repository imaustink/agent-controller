package workflows_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"

	"github.com/controller-agent/temporal-engine/internal/messaging"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/temporal/workflows"
	"github.com/controller-agent/temporal-engine/internal/toolrun"
)

type toolRunEnv struct {
	env      *testsuite.TestWorkflowEnvironment
	launched *activities.LaunchToolRunInput
	phase    toolrun.Status
}

func newToolRunEnv(t *testing.T) *toolRunEnv {
	t.Helper()
	suite := &testsuite.WorkflowTestSuite{}
	te := &toolRunEnv{env: suite.NewTestWorkflowEnvironment()}

	te.env.RegisterWorkflowWithOptions(workflows.ToolRunWorkflow, workflow.RegisterOptions{
		Name: workflows.ToolRunWorkflowName,
	})
	te.env.RegisterActivityWithOptions(func(_ context.Context, in activities.LaunchToolRunInput) error {
		te.launched = &in
		return nil
	}, activity.RegisterOptions{Name: activities.LaunchToolRunActivityName})
	te.env.RegisterActivityWithOptions(func(_ context.Context, jobID string) (toolrun.Status, error) {
		return te.phase, nil
	}, activity.RegisterOptions{Name: activities.GetToolRunPhaseActivityName})
	return te
}

// signalEvents delivers events once the launch has been captured,
// rescheduling in virtual time until it has (activity completions run on
// real goroutines and can trail virtual-time callbacks).
func (te *toolRunEnv) signalEvents(events ...messaging.Event) {
	var attempt func()
	attempt = func() {
		if te.launched == nil {
			te.env.RegisterDelayedCallback(attempt, 100*time.Millisecond)
			return
		}
		for _, event := range events {
			event.JobID = te.launched.JobID
			te.env.SignalWorkflow(workflows.ToolEventSignalPrefix+te.launched.JobID, event)
		}
	}
	attempt()
}

func TestToolRunWorkflowHappyPath(t *testing.T) {
	te := newToolRunEnv(t)

	te.env.RegisterDelayedCallback(func() {
		te.signalEvents(
			messaging.Event{Seq: 1, TS: "t", Type: "progress", Stage: "extract", Message: "reading page"},
			messaging.Event{Seq: 1, TS: "t", Type: "progress", Stage: "extract", Message: "duplicate delivery"},
			messaging.Event{Seq: 2, TS: "t", Type: "succeeded", Result: json.RawMessage(`"# Pasta\nBoil water."`)},
		)
	}, time.Millisecond)

	te.env.ExecuteWorkflow(workflows.ToolRunWorkflowName, workflows.ToolRunWorkflowInput{
		ToolRef: "recipe-scraper",
		Input:   "https://example.com/pasta",
	})

	require.True(t, te.env.IsWorkflowCompleted())
	require.NoError(t, te.env.GetWorkflowError())

	var outcome workflows.ToolOutcome
	require.NoError(t, te.env.GetWorkflowResult(&outcome))
	require.True(t, outcome.Succeeded)
	require.Equal(t, "# Pasta\nBoil water.", outcome.Result)
	require.Equal(t, outcome.JobID, te.launched.JobID)
	require.Equal(t, "recipe-scraper", te.launched.ToolRef)
	require.Equal(t, []string{"https://example.com/pasta"}, te.launched.Args)

	// Duplicate seq 1 was dropped: one narration line, not two.
	val, err := te.env.QueryWorkflow(workflows.ToolProgressQuery)
	require.NoError(t, err)
	var progress workflows.ToolProgress
	require.NoError(t, val.Get(&progress))
	require.Equal(t, []string{"extract: reading page"}, progress.Narration)
}

func TestToolRunWorkflowToolFailure(t *testing.T) {
	te := newToolRunEnv(t)
	te.env.RegisterDelayedCallback(func() {
		te.signalEvents(messaging.Event{Seq: 1, TS: "t", Type: "failed", Code: "blocked_url", Message: "SSRF guard rejected host"})
	}, time.Millisecond)

	te.env.ExecuteWorkflow(workflows.ToolRunWorkflowName, workflows.ToolRunWorkflowInput{ToolRef: "recipe-scraper", Input: "http://169.254.169.254"})

	require.True(t, te.env.IsWorkflowCompleted())
	require.NoError(t, te.env.GetWorkflowError(), "tool failure is an outcome, not a workflow error")

	var outcome workflows.ToolOutcome
	require.NoError(t, te.env.GetWorkflowResult(&outcome))
	require.False(t, outcome.Succeeded)
	require.Equal(t, "blocked_url", outcome.ErrorCode)
	require.Contains(t, outcome.ErrorMessage, "SSRF")
}

func TestToolRunWorkflowTimeoutUsesPhaseBackstop(t *testing.T) {
	te := newToolRunEnv(t)
	te.phase = toolrun.Status{Phase: toolrun.PhaseFailed, Message: "Job has reached the specified backoff limit"}
	// No signals at all — the tool crashed without emitting `failed`.

	te.env.ExecuteWorkflow(workflows.ToolRunWorkflowName, workflows.ToolRunWorkflowInput{ToolRef: "recipe-scraper", Input: "x", TimeoutSeconds: 30})

	require.True(t, te.env.IsWorkflowCompleted())
	require.NoError(t, te.env.GetWorkflowError())

	var outcome workflows.ToolOutcome
	require.NoError(t, te.env.GetWorkflowResult(&outcome))
	require.False(t, outcome.Succeeded)
	require.Equal(t, "job_failed", outcome.ErrorCode)
	require.Contains(t, outcome.ErrorMessage, "backoff limit")
}
