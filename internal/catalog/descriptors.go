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
	ToolGVR  = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "tools"}
	SkillGVR = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "skills"}
	AgentGVR = schema.GroupVersionResource{Group: Group, Version: Version, Resource: "agents"}
)

type ToolDescriptor struct {
	ID           string   `json:"id"` // CR name; doubles as ToolRun spec.toolRef
	Description  string   `json:"description"`
	Input        string   `json:"input,omitempty"`
	Output       string   `json:"output,omitempty"`
	AllowedRoles []string `json:"allowedRoles"`
	Tier         string   `json:"tier,omitempty"`
	AgentRef     string   `json:"agentRef,omitempty"` // set = agent-backed tool
}

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
}

type SkillDescriptor struct {
	ID          string   `json:"id"`
	Description string   `json:"description"`
	Input       string   `json:"input,omitempty"`
	Output      string   `json:"output,omitempty"`
	Markdown    string   `json:"markdown"`
	ToolIDs     []string `json:"toolIds,omitempty"`
	AgentIDs    []string `json:"agentIds,omitempty"`

	// Derived at index time (ADR 0011): the intersection of every referenced
	// tool's/agent's allowedRoles. Unrestricted=true (no refs) means visible
	// to any resolved identity; otherwise empty EffectiveRoles means visible
	// to no one (dangling ref or disjoint roles — fail closed).
	EffectiveRoles []string `json:"effectiveRoles,omitempty"`
	Unrestricted   bool     `json:"unrestricted,omitempty"`
}

// EmbeddingText is what gets vectorized for retrieval, mirroring
// agent-controller's "description + Input/Output" composition.
func (t ToolDescriptor) EmbeddingText() string  { return embeddingText(t.Description, t.Input, t.Output) }
func (a AgentDescriptor) EmbeddingText() string { return embeddingText(a.Description, a.Input, a.Output) }
func (s SkillDescriptor) EmbeddingText() string { return embeddingText(s.Description, s.Input, s.Output) }

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
