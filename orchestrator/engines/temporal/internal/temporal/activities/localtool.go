package activities

import (
	"context"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/localtool"
	"github.com/controller-agent/temporal-engine/internal/messaging"
)

const RunLocalToolActivityName = "RunLocalTool"

type RunLocalToolInput struct {
	Tool      catalog.ToolDescriptor `json:"tool"`
	Input     string                 `json:"input"`
	SessionID string                 `json:"sessionId,omitempty"`
}

// LocalToolActivities dispatches a LocalTool (ADR 0014) to its executor
// sidecar. All I/O — the unix-socket POST and any k8s Secret reads for
// secretEnv — happens here, at the activity boundary, same as every other
// external call this workflow makes.
type LocalToolActivities struct {
	Executor *localtool.Executor
}

// RunLocalTool runs one LocalTool call and returns the resulting event.
// Every failure mode is a "failed" Event, never a Go error — a local run's
// outcome is a result for the caller to reason about, the same discipline a
// Job callback's outcome gets.
func (a *LocalToolActivities) RunLocalTool(ctx context.Context, in RunLocalToolInput) (messaging.Event, error) {
	return a.Executor.Run(ctx, in.Tool, in.Input, in.SessionID), nil
}
