package catalog

import (
	"fmt"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
)

// Spec mirrors of the upstream v1alpha1 types (catalog fields only; launch
// fields like image/env/resources are ignored — the controller owns those).

type toolSpec struct {
	Description       string   `json:"description"`
	Input             string   `json:"input"`
	Output            string   `json:"output"`
	AllowedRoles      []string `json:"allowedRoles"`
	Tier              string   `json:"tier,omitempty"`
	AgentRef          string   `json:"agentRef,omitempty"`
	IdentityProviders []string `json:"identityProviders,omitempty"`
}

type agentSpec struct {
	Description        string   `json:"description"`
	Input              string   `json:"input"`
	Output             string   `json:"output"`
	AllowedRoles       []string `json:"allowedRoles"`
	Tier               string   `json:"tier,omitempty"`
	OrchestratorPrompt string   `json:"orchestratorPrompt,omitempty"`
	AgentPrompt        string   `json:"agentPrompt,omitempty"`
	SkillRefs          []string `json:"skillRefs,omitempty"`
	Model              string   `json:"model,omitempty"`
	MaxIterations      int32    `json:"maxIterations,omitempty"`
	IdentityProviders  []string `json:"identityProviders,omitempty"`
	ToolRefs           []string `json:"toolRefs,omitempty"`
}

type skillSpec struct {
	Description      string   `json:"description"`
	Input            string   `json:"input,omitempty"`
	Output           string   `json:"output,omitempty"`
	Markdown         string   `json:"markdown"`
	ToolRefs         []string `json:"toolRefs,omitempty"`
	AgentRefs        []string `json:"agentRefs,omitempty"`
	AllowCallerTools *bool    `json:"allowCallerTools,omitempty"`
}

func decodeSpec(obj *unstructured.Unstructured, into any) error {
	spec, found, err := unstructured.NestedMap(obj.Object, "spec")
	if err != nil || !found {
		return fmt.Errorf("%s %q has no spec: %w", obj.GetKind(), obj.GetName(), err)
	}
	return runtime.DefaultUnstructuredConverter.FromUnstructured(spec, into)
}

func DecodeTool(obj *unstructured.Unstructured) (ToolDescriptor, error) {
	var spec toolSpec
	if err := decodeSpec(obj, &spec); err != nil {
		return ToolDescriptor{}, err
	}
	return ToolDescriptor{
		ID:                obj.GetName(),
		Description:       spec.Description,
		Input:             spec.Input,
		Output:            spec.Output,
		AllowedRoles:      spec.AllowedRoles,
		Tier:              spec.Tier,
		AgentRef:          spec.AgentRef,
		IdentityProviders: spec.IdentityProviders,
	}, nil
}

func DecodeAgent(obj *unstructured.Unstructured) (AgentDescriptor, error) {
	var spec agentSpec
	if err := decodeSpec(obj, &spec); err != nil {
		return AgentDescriptor{}, err
	}
	return AgentDescriptor{
		ID:                 obj.GetName(),
		StepToolRef:        obj.GetAnnotations()[StepToolAnnotation],
		Description:        spec.Description,
		Input:              spec.Input,
		Output:             spec.Output,
		AllowedRoles:       spec.AllowedRoles,
		Tier:               spec.Tier,
		OrchestratorPrompt: spec.OrchestratorPrompt,
		AgentPrompt:        spec.AgentPrompt,
		SkillRefs:          spec.SkillRefs,
		Model:              spec.Model,
		MaxIterations:      spec.MaxIterations,
		IdentityProviders:  spec.IdentityProviders,
		ToolRefs:           spec.ToolRefs,
	}, nil
}

// DecodeSkill returns the skill without EffectiveRoles/Unrestricted;
// DeriveSkillAccess fills those in against the current tool/agent catalogs.
func DecodeSkill(obj *unstructured.Unstructured) (SkillDescriptor, error) {
	var spec skillSpec
	if err := decodeSpec(obj, &spec); err != nil {
		return SkillDescriptor{}, err
	}
	return SkillDescriptor{
		ID:               obj.GetName(),
		Description:      spec.Description,
		Input:            spec.Input,
		Output:           spec.Output,
		Markdown:         spec.Markdown,
		ToolIDs:          spec.ToolRefs,
		AgentIDs:         spec.AgentRefs,
		AllowCallerTools: spec.AllowCallerTools,
	}, nil
}
