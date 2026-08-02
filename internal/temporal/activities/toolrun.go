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

	// CredentialSecretName and CredentialEnvVars reference the caller-scoped
	// credentials this launch carries (ADR 0032 §1's ToolRunSpec.secretEnv).
	//
	// A name and a list of keys, never values — the pre-flight wrote the
	// values straight into that Secret precisely so they never travel through
	// a workflow, and therefore never reach Temporal's event history. Every
	// key in CredentialEnvVars is both the env var name and the Secret key.
	CredentialSecretName string   `json:"credentialSecretName,omitempty"`
	CredentialEnvVars    []string `json:"credentialEnvVars,omitempty"`
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
	var secretEnv []toolrun.SecretEnvVar
	for _, name := range in.CredentialEnvVars {
		if in.CredentialSecretName == "" {
			return fmt.Errorf("launch %s: credential env vars named without a secret", in.JobID)
		}
		secretEnv = append(secretEnv, toolrun.SecretEnvVar{
			Name:      name,
			SecretRef: toolrun.SecretKeySelector{Name: in.CredentialSecretName, Key: name},
		})
	}

	return a.Launcher.Launch(ctx, toolrun.LaunchSpec{
		Name:           in.JobID,
		ToolRef:        in.ToolRef,
		Args:           in.Args,
		CallbackURL:    callbackURL,
		TimeoutSeconds: in.TimeoutSeconds,
		SecretEnv:      secretEnv,
	})
}

func (a *ToolRunActivities) GetToolRunPhase(ctx context.Context, jobID string) (toolrun.Status, error) {
	return a.Launcher.GetStatus(ctx, jobID)
}
