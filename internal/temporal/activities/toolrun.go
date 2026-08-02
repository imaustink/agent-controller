package activities

import (
	"context"
	"fmt"
	"strings"

	"durable-agents/internal/toolrun"
)

const (
	LaunchToolRunActivityName   = "LaunchToolRun"
	GetToolRunPhaseActivityName = "GetToolRunPhase"
)

type LaunchToolRunInput struct {
	// JobID names the ToolRun CR and correlates the callback stream. The
	// workflow generates it once (SideEffect) so activity retries stay
	// idempotent.
	JobID          string   `json:"jobId"`
	ToolRef        string   `json:"toolRef"`
	Args           []string `json:"args,omitempty"`
	WorkflowID     string   `json:"workflowId"`
	TimeoutSeconds int32    `json:"timeoutSeconds,omitempty"`
}

type ToolRunActivities struct {
	Launcher toolrun.Launcher
	// CallbackBaseURL is the gateway's callback listener as reachable from
	// tool Job pods, e.g. http://durable-agents-gateway-callback:8081
	CallbackBaseURL string
}

func (a *ToolRunActivities) LaunchToolRun(ctx context.Context, in LaunchToolRunInput) error {
	if in.JobID == "" || in.WorkflowID == "" {
		return fmt.Errorf("launch requires jobId and workflowId")
	}
	callbackURL := fmt.Sprintf("%s/callback/%s/%s",
		strings.TrimRight(a.CallbackBaseURL, "/"), in.WorkflowID, in.JobID)
	return a.Launcher.Launch(ctx, toolrun.LaunchSpec{
		Name:           in.JobID,
		ToolRef:        in.ToolRef,
		Args:           in.Args,
		CallbackURL:    callbackURL,
		TimeoutSeconds: in.TimeoutSeconds,
	})
}

func (a *ToolRunActivities) GetToolRunPhase(ctx context.Context, jobID string) (toolrun.Status, error) {
	return a.Launcher.GetStatus(ctx, jobID)
}
