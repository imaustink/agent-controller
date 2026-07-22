// Package toolrun creates and inspects agent-controller ToolRun CRs — the
// only way this system runs a tool. The Go core-controller reconciles each
// CR into a hardened one-shot Job; we never touch batch/jobs.
package toolrun

import (
	"context"
)

// LaunchSpec is one tool invocation.
type LaunchSpec struct {
	// Name becomes the ToolRun CR name and the callback correlation job id.
	Name string
	// ToolRef names the Tool CR to run.
	ToolRef string
	// Args are appended after the Tool's static args.
	Args []string
	// CallbackURL is where the Job posts its HMAC-signed event stream.
	CallbackURL string
	// TimeoutSeconds bounds the Job's activeDeadlineSeconds (0 = controller default).
	TimeoutSeconds int32
}

// Phases mirror ToolRunPhase upstream.
const (
	PhasePending   = "Pending"
	PhaseRunning   = "Running"
	PhaseSucceeded = "Succeeded"
	PhaseFailed    = "Failed"
)

type Status struct {
	Phase   string `json:"phase,omitempty"`
	Message string `json:"message,omitempty"`
	JobName string `json:"jobName,omitempty"`
}

// Launcher is the port; K8sLauncher is the real implementation, FakeLauncher
// the cluster-less dev stand-in.
type Launcher interface {
	// Launch creates the ToolRun. Idempotent: an AlreadyExists on retry is
	// success (the workflow generates the name once).
	Launch(ctx context.Context, spec LaunchSpec) error
	// GetStatus reads the CR's mirrored Job status — the crash backstop when
	// no terminal callback ever arrives.
	GetStatus(ctx context.Context, name string) (Status, error)
}
