// Package catalog decodes agent-controller's Tool/Skill/Agent custom
// resources (core.controller-agent.dev/v1alpha1) into the descriptors this
// system indexes and retrieves. Launch details (image, env, resources) stay
// with the upstream controller — a ToolRun only needs the tool's name — so
// descriptors carry catalog metadata only.
package catalog

import "k8s.io/apimachinery/pkg/runtime/schema"

const (
	Group   = "core.controller-agent.dev"
	Version = "v1alpha1"
)

var (
	ToolGVR      = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "tools"}
	SkillGVR     = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "skills"}
	AgentGVR     = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "agents"}
	LocalToolGVR = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "localtools"}
)

type ToolDescriptor struct {
	ID           string   `json:"id"` // CR name; doubles as ToolRun spec.toolRef
	Description  string   `json:"description"`
	Input        string   `json:"input,omitempty"`
	Output       string   `json:"output,omitempty"`
	AllowedRoles []string `json:"allowedRoles"`
	Tier         string   `json:"tier,omitempty"`
	AgentRef     string   `json:"agentRef,omitempty"` // set = agent-backed tool

	// IdentityProviders names the external identities the caller must have
	// linked before this Tool may be launched (upstream ADR 0032 §2). Only
	// meaningful for a container Tool — an agent-backed Tool carries it on
	// the wrapped Agent CR instead. The resolved token rides the launch as
	// ToolRunSpec.secretEnv rather than being baked into the Tool template.
	IdentityProviders []string `json:"identityProviders,omitempty"`

	// LocalExec, when set, means this descriptor came from a LocalTool CR
	// (ADR 0014) rather than a Tool CR: it is never launched as a k8s Job,
	// but dispatched in-pod to the matching per-language executor sidecar.
	LocalExec *LocalExecSpec `json:"localExec,omitempty"`
}

// SecretEnvRef names a tool process environment variable whose value comes
// from a Secret key, resolved by the engine (which holds the k8s identity)
// before the request ever reaches a sidecar (which deliberately has none).
type SecretEnvRef struct {
	Name       string `json:"name"`
	SecretName string `json:"secretName"`
	SecretKey  string `json:"secretKey"`
}

// LocalExecSpec mirrors LocalToolSpec (controllers/core-controller/api/
// v1alpha1/localtool_types.go, ADR 0014): packaged code fetched by and run
// inside a per-language executor sidecar, over a pod-local unix socket,
// instead of a k8s Job.
type LocalExecSpec struct {
	Runtime        string            `json:"runtime"`
	Package        string            `json:"package,omitempty"`
	Version        string            `json:"version,omitempty"`
	Entry          string            `json:"entry,omitempty"`
	SourceURL      string            `json:"sourceUrl,omitempty"`
	Checksum       string            `json:"checksum,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	SecretEnv      []SecretEnvRef    `json:"secretEnv,omitempty"`
	Network        bool              `json:"network,omitempty"`
	TimeoutSeconds int32             `json:"timeoutSeconds,omitempty"`
}

// StepToolAnnotation on an Agent CR marks it as a checkpoint-resume pod
// agent: each work step runs the named Tool as a one-shot Job speaking the
// messaging.AgentStepResult envelope. This is a durable-agents extension —
// upstream's Agent.spec.image/AgentRun launch path is unused for these.
const StepToolAnnotation = "durable-agents.dev/step-tool"

// BridgedAnnotation on an Agent CR marks it as an UNMODIFIED upstream pod
// agent: launched as an ordinary AgentRun and driven over the existing
// bidirectional NATS protocol, with a workflow holding the durable half of the
// conversation.
//
// This is how claude-code-swe-agent and opencode-swe-agent run here without
// being rewritten. Their images, their protocol, their CR — only the thing
// waiting on them changes.
const BridgedAnnotation = "durable-agents.dev/bridged"

type AgentDescriptor struct {
	ID                 string   `json:"id"`
	Description        string   `json:"description"`
	Input              string   `json:"input,omitempty"`
	Output             string   `json:"output,omitempty"`
	AllowedRoles       []string `json:"allowedRoles"`
	Tier               string   `json:"tier,omitempty"`
	OrchestratorPrompt string   `json:"orchestratorPrompt,omitempty"`
	AgentPrompt        string   `json:"agentPrompt,omitempty"`
	SkillRefs          []string `json:"skillRefs,omitempty"`
	Model              string   `json:"model,omitempty"`
	MaxIterations      int32    `json:"maxIterations,omitempty"`
	IdentityProviders  []string `json:"identityProviders,omitempty"`

	// ToolRefs names the Tool CRs this agent's OWN loop may call (upstream
	// ADR 0028), as opposed to SkillRefs, which is prompt material. Resolved
	// by id against the whole catalog rather than through RBAC-filtered
	// retrieval: the question is which tools the OPERATOR declared this agent
	// may call, not which tools the walk-in caller may reach. Re-validated at
	// call time — the CRD-level check upstream performs is a static-config
	// sanity check, not the authorization boundary.
	ToolRefs []string `json:"toolRefs,omitempty"`

	// StepToolRef (from StepToolAnnotation) switches execution from the
	// declarative agent loop to checkpoint-resume Jobs of the named tool.
	StepToolRef string `json:"stepToolRef,omitempty"`

	// Bridged (from BridgedAnnotation) runs this agent as an unmodified
	// upstream AgentRun over the NATS protocol. Mutually exclusive with
	// StepToolRef; if both are set, StepToolRef wins, because a step tool is a
	// concrete statement about how the image behaves while Bridged is a
	// statement about which transport to use.
	Bridged bool `json:"bridged,omitempty"`
}

type SkillDescriptor struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	Input       string   `json:"input,omitempty"`
	Output      string   `json:"output,omitempty"`
	Markdown    string   `json:"markdown"`
	ToolIDs     []string `json:"toolIds,omitempty"`
	AgentIDs    []string `json:"agentIds,omitempty"`

	// AllowCallerTools controls whether tools the CONSUMER supplied in the
	// request body (upstream ADR 0035) may be offered to the planner
	// alongside this skill's own tools. A pointer because **nil means
	// allowed** — the default that matches the OpenAI wire contract is "the
	// tools I sent are usable", and a plain bool's zero value would silently
	// mean "refuse" on every existing Skill CR. Not an authorization
	// boundary: it keeps an authored skill's tool loop predictable, nothing
	// more (the caller both supplies and executes a caller tool).
	AllowCallerTools *bool `json:"allowCallerTools,omitempty"`

	// Derived at index time (ADR 0011): the intersection of every referenced
	// tool's/agent's allowedRoles. Unrestricted=true (no refs) means visible
	// to any resolved identity; otherwise empty EffectiveRoles means visible
	// to no one (dangling ref or disjoint roles — fail closed).
	EffectiveRoles []string `json:"effectiveRoles,omitempty"`
	Unrestricted   bool     `json:"unrestricted,omitempty"`
}

// EmbeddingText is what gets vectorized for retrieval, mirroring
// agent-controller's "description + Input/Output" composition.
func (t ToolDescriptor) EmbeddingText() string {
	return embeddingText(t.Description, t.Input, t.Output)
}
func (a AgentDescriptor) EmbeddingText() string {
	return embeddingText(a.Description, a.Input, a.Output)
}
func (s SkillDescriptor) EmbeddingText() string {
	return embeddingText(s.Description, s.Input, s.Output)
}

func embeddingText(description, input, output string) string {
	text := description
	if input != "" {
		text += "\n\nInput: " + input
	}
	if output != "" {
		text += "\nOutput: " + output
	}
	return text
}
