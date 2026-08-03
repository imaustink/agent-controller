package workflows

import (
	"go.temporal.io/sdk/workflow"

	"durable-agents/internal/messaging"
)

const (
	// ToolRunWorkflowName runs a single tool call end to end — the ops/debug
	// entry point (`temporal workflow start --type ToolRunWorkflow ...`) and
	// the building block the agent loop composes in milestone 4.
	ToolRunWorkflowName = "ToolRunWorkflow"

	// ToolProgressQuery exposes the job id and accumulated narration.
	ToolProgressQuery = "tool-progress"
)

type ToolRunWorkflowInput struct {
	ToolRef        string   `json:"toolRef"`
	Input          string   `json:"input,omitempty"` // convenience single arg
	Args           []string `json:"args,omitempty"`  // overrides Input when set
	TimeoutSeconds int32    `json:"timeoutSeconds,omitempty"`
}

type ToolProgress struct {
	JobID     string   `json:"jobId"`
	Narration []string `json:"narration,omitempty"`
}

func ToolRunWorkflow(ctx workflow.Context, in ToolRunWorkflowInput) (ToolOutcome, error) {
	progress := ToolProgress{}
	if err := workflow.SetQueryHandler(ctx, ToolProgressQuery, func() (ToolProgress, error) {
		return progress, nil
	}); err != nil {
		return ToolOutcome{}, err
	}

	args := in.Args
	if len(args) == 0 && in.Input != "" {
		args = []string{in.Input}
	}

	return runTool(ctx, RunToolParams{
		ToolRef:        in.ToolRef,
		Args:           args,
		TimeoutSeconds: in.TimeoutSeconds,
		OnJobID:        func(id string) { progress.JobID = id },
		OnProgress: func(e messaging.Event) {
			line := e.Message
			if e.Stage != "" {
				line = e.Stage + ": " + line
			}
			progress.Narration = append(progress.Narration, line)
		},
	})
}
