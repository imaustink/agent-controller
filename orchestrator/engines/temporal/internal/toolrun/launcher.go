// Package toolrun creates and inspects agent-controller ToolRun CRs — the
// only way this system runs a tool. The Go core-controller reconciles each
// CR into a hardened one-shot Job; we never touch batch/jobs.
package toolrun

import (
	"context"
)

// SecretKeySelector points at one key of one Secret in the ToolRun's
// namespace. Mirrors upstream v1alpha1.SecretKeySelector.
type SecretKeySelector struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

// SecretEnvVar is a per-invocation environment variable sourced from a Secret
// key, merged over the referenced Tool's static ToolSpec.secretEnv at
// Job-build time (an entry with the same Name wins for this run only).
//
// This is how a caller-scoped credential rides a tool launch without being
// baked into the Tool template — upstream added it in ADR 0032 §1, closing
// the gap docs/pod-agents.md recorded as blocking per-user token injection on
// checkpoint-resume step Jobs.
//
// Note what this carries: a *reference*, never a value. The plaintext travels
// gateway -> launcher -> Secret and is redeemed by the kubelet. That matters
// more here than it does upstream, because anything a workflow puts in its
// own state is written to Temporal event history durably and in the clear.
type SecretEnvVar struct {
	Name      string            `json:"name"`
	SecretRef SecretKeySelector `json:"secretRef"`
}

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
	// SecretEnv are per-invocation credential references for this run only.
	SecretEnv []SecretEnvVar
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
