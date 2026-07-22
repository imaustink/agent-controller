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

	"durable-agents/internal/messaging"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/temporal/workflows"
	"durable-agents/internal/toolrun"
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

// jobID reads the workflow's generated job id from the captured launch
// input — only valid inside a delayed callback that fires after launch.
func (te *toolRunEnv) jobID(t *testing.T) string {
	require.NotNil(t, te.launched, "launch activity should have run")
	require.NotEmpty(t, te.launched.JobID)
	return te.launched.JobID
}

func (te *toolRunEnv) signalEvent(t *testing.T, jobID string, event messaging.Event) {
	event.JobID = jobID
	te.env.SignalWorkflow(workflows.ToolEventSignalPrefix+jobID, event)
}

func TestToolRunWorkflowHappyPath(t *testing.T) {
	te := newToolRunEnv(t)

	te.env.RegisterDelayedCallback(func() {
		jobID := te.jobID(t)
		te.signalEvent(t, jobID, messaging.Event{Seq: 1, TS: "t", Type: "progress", Stage: "extract", Message: "reading page"})
		te.signalEvent(t, jobID, messaging.Event{Seq: 1, TS: "t", Type: "progress", Stage: "extract", Message: "duplicate delivery"})
		te.signalEvent(t, jobID, messaging.Event{Seq: 2, TS: "t", Type: "succeeded", Result: json.RawMessage(`"# Pasta\nBoil water."`)})
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
		te.signalEvent(t, te.jobID(t), messaging.Event{Seq: 1, TS: "t", Type: "failed", Code: "blocked_url", Message: "SSRF guard rejected host"})
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
