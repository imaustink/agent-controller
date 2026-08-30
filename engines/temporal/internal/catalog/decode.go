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

type envVarSpec struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type secretEnvVarSpec struct {
	Name      string `json:"name"`
	SecretRef struct {
		Name string `json:"name"`
		Key  string `json:"key"`
	} `json:"secretRef"`
}

// localToolSpec mirrors controllers/core-controller/api/v1alpha1.LocalToolSpec
// (ADR 0014) — catalog fields plus the packaging/execution fields the
// engine forwards verbatim to the executor sidecar.
type localToolSpec struct {
	Description    string             `json:"description"`
	Input          string             `json:"input"`
	Output         string             `json:"output"`
	AllowedRoles   []string           `json:"allowedRoles"`
	Tier           string             `json:"tier,omitempty"`
	Runtime        string             `json:"runtime"`
	Package        string             `json:"package,omitempty"`
	Version        string             `json:"version,omitempty"`
	Entry          string             `json:"entry,omitempty"`
	SourceURL      string             `json:"sourceURL,omitempty"`
	Checksum       string             `json:"checksum,omitempty"`
	Env            []envVarSpec       `json:"env,omitempty"`
	SecretEnv      []secretEnvVarSpec `json:"secretEnv,omitempty"`
	Network        bool               `json:"network,omitempty"`
	TimeoutSeconds int32              `json:"timeoutSeconds,omitempty"`
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

// DecodeLocalTool reads a LocalTool CR (ADR 0014) into the same
// ToolDescriptor shape a container Tool produces, so a skill's toolRefs can
// reference either kind transparently — LocalExec is the marker that
// distinguishes it, mirroring how AgentRef marks an agent-backed Tool.
func DecodeLocalTool(obj *unstructured.Unstructured) (ToolDescriptor, error) {
	var spec localToolSpec
	if err := decodeSpec(obj, &spec); err != nil {
		return ToolDescriptor{}, err
	}

	var env map[string]string
	if len(spec.Env) > 0 {
		env = make(map[string]string, len(spec.Env))
		for _, e := range spec.Env {
			env[e.Name] = e.Value
		}
	}
	var secretEnv []SecretEnvRef
	for _, e := range spec.SecretEnv {
		secretEnv = append(secretEnv, SecretEnvRef{Name: e.Name, SecretName: e.SecretRef.Name, SecretKey: e.SecretRef.Key})
	}

	return ToolDescriptor{
		ID:           obj.GetName(),
		Description:  spec.Description,
		Input:        spec.Input,
		Output:       spec.Output,
		AllowedRoles: spec.AllowedRoles,
		Tier:         spec.Tier,
		LocalExec: &LocalExecSpec{
			Runtime:        spec.Runtime,
			Package:        spec.Package,
			Version:        spec.Version,
			Entry:          spec.Entry,
			SourceURL:      spec.SourceURL,
			Checksum:       spec.Checksum,
			Env:            env,
			SecretEnv:      secretEnv,
			Network:        spec.Network,
			TimeoutSeconds: spec.TimeoutSeconds,
		},
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
		Bridged:            obj.GetAnnotations()[BridgedAnnotation] == "true",
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
