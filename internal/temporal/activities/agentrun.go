package activities

import (
	"context"
	"fmt"
	"strings"

	"go.temporal.io/sdk/activity"

	"durable-agents/internal/agentrun"
	"durable-agents/internal/toolrun"
)

const (
	LaunchAgentRunActivityName   = "LaunchAgentRun"
	GetAgentRunPhaseActivityName = "GetAgentRunPhase"
	SendAgentDownActivityName    = "SendAgentDown"
	DetachAgentRunActivityName   = "DetachAgentRun"
)

type LaunchAgentRunInput struct {
	// RunID names the AgentRun CR, is the protocol's agent_run_id, and
	// therefore determines the NATS subjects. The workflow generates it once
	// (SideEffect) so activity retries stay idempotent.
	RunID          string `json:"runId"`
	AgentRef       string `json:"agentRef"`
	Goal           string `json:"goal"`
	WorkflowID     string `json:"workflowId"`
	TimeoutSeconds int32  `json:"timeoutSeconds,omitempty"`

	// Credentials reference the Secret the authorization pre-flight wrote. A
	// name and key names only — see internal/authz on event history.
	CredentialSecretName string   `json:"credentialSecretName,omitempty"`
	CredentialEnvVars    []string `json:"credentialEnvVars,omitempty"`
}

// AgentDownInput sends one message down to a running agent.
type AgentDownInput struct {
	RunID string `json:"runId"`
	Type  string `json:"type"`

	Message string `json:"message,omitempty"` // prompt
	Reason  string `json:"reason,omitempty"`  // cancel

	// tool_result
	CallID string `json:"callId,omitempty"`
	OK     bool   `json:"ok,omitempty"`
	Result string `json:"result,omitempty"`
	Error  string `json:"error,omitempty"`
}

// AgentRunActivities launch pod agents and carry messages to them.
//
// Attach happens inside the launch activity, BEFORE the CR is created: the
// subscription has to exist before the agent can publish `ready`, or core NATS
// (which has no durability and no replay) drops it and the workflow waits
// forever for something already said.
type AgentRunActivities struct {
	Launcher agentrun.Launcher
	Bridge   *agentrun.Bridge
	// CallbackBaseURL is the gateway's callback listener as reachable from Job
	// pods. Required by the CRD; a NATS-driven agent reports over its own
	// channel and generally never posts to it.
	CallbackBaseURL string
}

func (a *AgentRunActivities) LaunchAgentRun(ctx context.Context, in LaunchAgentRunInput) error {
	if in.RunID == "" || in.WorkflowID == "" {
		return fmt.Errorf("launch requires runId and workflowId")
	}

	if err := a.Bridge.Attach(in.RunID, in.WorkflowID); err != nil {
		return fmt.Errorf("attach bridge for %s: %w", in.RunID, err)
	}

	var secretEnv []toolrun.SecretEnvVar
	for _, name := range in.CredentialEnvVars {
		if in.CredentialSecretName == "" {
			return fmt.Errorf("launch %s: credential env vars named without a secret", in.RunID)
		}
		secretEnv = append(secretEnv, toolrun.SecretEnvVar{
			Name:      name,
			SecretRef: toolrun.SecretKeySelector{Name: in.CredentialSecretName, Key: name},
		})
	}

	err := a.Launcher.Launch(ctx, agentrun.LaunchSpec{
		Name:     in.RunID,
		AgentRef: in.AgentRef,
		Goal:     in.Goal,
		CallbackURL: fmt.Sprintf("%s/callback/%s/%s",
			strings.TrimRight(a.CallbackBaseURL, "/"), in.WorkflowID, in.RunID),
		TimeoutSeconds: in.TimeoutSeconds,
		SecretEnv:      secretEnv,
	})
	if err != nil {
		a.Bridge.Detach(in.RunID)
		return err
	}
	return nil
}

func (a *AgentRunActivities) GetAgentRunPhase(ctx context.Context, runID string) (toolrun.Status, error) {
	return a.Launcher.GetStatus(ctx, runID)
}

// SendAgentDown publishes one down-message. Re-attaches first, so a worker that
// restarted mid-episode can still reach a running agent — the subjects are
// derived from the run id, not from any local state.
func (a *AgentRunActivities) SendAgentDown(ctx context.Context, in AgentDownInput) error {
	workflowID := workflowIDFromContext(ctx)
	if workflowID != "" {
		if err := a.Bridge.Attach(in.RunID, workflowID); err != nil {
			return err
		}
	}

	switch in.Type {
	case agentrun.DownPrompt:
		return a.Bridge.Prompt(in.RunID, in.Message)
	case agentrun.DownCancel:
		return a.Bridge.Cancel(in.RunID, in.Reason)
	case agentrun.DownToolResult:
		return a.Bridge.ToolResult(in.RunID, in.CallID, in.OK, in.Result, in.Error)
	default:
		return fmt.Errorf("unsupported down-message type %q", in.Type)
	}
}

// DetachAgentRun releases a finished run's subscription. Best-effort: a leaked
// subscription costs memory on one worker, and the run is over either way.
func (a *AgentRunActivities) DetachAgentRun(_ context.Context, runID string) error {
	a.Bridge.Detach(runID)
	return nil
}

// workflowIDFromContext reads the calling workflow's id, which is where a
// re-attach has to point. Empty outside an activity context (tests).
func workflowIDFromContext(ctx context.Context) string {
	if !activity.IsActivity(ctx) {
		return ""
	}
	return activity.GetInfo(ctx).WorkflowExecution.ID
}
