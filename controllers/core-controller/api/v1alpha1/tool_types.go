/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.

// EnvVar is a plain name/value pair injected into the tool's Job container.
// Values that must come from Secrets belong on `secretEnv` below (or the
// ToolRun's callback secretRef) — never a literal here.
type EnvVar struct {
	// name of the environment variable.
	// +required
	Name string `json:"name"`

	// value of the environment variable.
	// +required
	Value string `json:"value"`
}

// SecretEnvVar names a Job container environment variable whose value comes
// from a Secret key in the SAME namespace as the Tool/ToolRun, resolved via
// corev1.EnvVarSource.SecretKeyRef at Job-build time. Only the reference
// (secret name + key) lives in the Tool spec — never the secret value
// itself, same discipline as ToolRunCallback.SecretRef for the callback
// HMAC secret. Needed because ordinary tool containers (e.g. recipe-scraper's
// OPENAI_API_KEY, recipe-publisher's GITHUB_TOKEN) require real secrets that
// `env` (non-secret, catalog metadata) cannot carry.
type SecretEnvVar struct {
	// name of the environment variable to set in the tool's Job container.
	// +required
	Name string `json:"name"`

	// secretRef selects the Secret key providing the value.
	// +required
	SecretRef SecretKeySelector `json:"secretRef"`
}

// ResourceRequirements mirrors corev1.ResourceRequirements' cpu/memory subset
// (kept narrow and explicit rather than importing the full corev1 type).
type ResourceRequirements struct {
	// +optional
	Requests map[string]string `json:"requests,omitempty"`
	// +optional
	Limits map[string]string `json:"limits,omitempty"`
}

// ToolSpec defines the desired state of Tool. Fields mirror the JS orchestrator's
// former manifest.json (ADR 0009) which this CRD supersedes (ADR 0010).
//
// A Tool is either a container Tool (image + serviceAccountName, launched as a
// ToolRun Job) or an agent-backed Tool (agentRef, dispatched by the
// orchestrator as an AgentRun instead) — exactly one of the two shapes, never
// both, enforced by the CEL rule below so a Skill's toolRefs can name either
// kind interchangeably without the orchestrator guessing which launch path
// applies.
// +kubebuilder:validation:XValidation:rule="(has(self.agentRef) && !has(self.image) && !has(self.serviceAccountName)) || (!has(self.agentRef) && has(self.image) && has(self.serviceAccountName))",message="exactly one of agentRef or (image and serviceAccountName) must be set"
type ToolSpec struct {
	// description is fed to the orchestrator's embedder for RAG tool retrieval.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// input describes the expected argv[2]/stdin contract for the tool's container.
	// +required
	Input string `json:"input"`

	// output describes the tool's result envelope shape.
	// +required
	Output string `json:"output"`

	// allowedRoles gates RAG retrieval (RBAC filter) — caller must have at least
	// one of these roles for this Tool to be considered a candidate.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// tier is an operator-defined cost/trust classification (e.g. "standard", "privileged").
	// +optional
	Tier string `json:"tier,omitempty"`

	// agentRef names an Agent CR (same namespace) this Tool wraps — the
	// orchestrator dispatches calls to this Tool as an AgentRun against that
	// Agent instead of launching a container Job. Mutually exclusive with
	// image/serviceAccountName (see the CEL rule on ToolSpec).
	// +optional
	AgentRef string `json:"agentRef,omitempty"`

	// image is the fully-qualified container image the ToolRun controller launches as a Job.
	// Required unless agentRef is set.
	// +optional
	Image string `json:"image,omitempty"`

	// serviceAccountName the Job pod runs as. Must already exist in-cluster —
	// this CRD/controller does not create tool ServiceAccounts. Required
	// unless agentRef is set.
	// +optional
	ServiceAccountName string `json:"serviceAccountName,omitempty"`

	// args are static extra container args appended after the caller-supplied input.
	// +optional
	Args []string `json:"args,omitempty"`

	// env are static, non-secret environment variables for the Job container.
	// +optional
	Env []EnvVar `json:"env,omitempty"`

	// secretEnv are environment variables for the Job container sourced from
	// Secret keys in the same namespace (e.g. OPENAI_API_KEY, GITHUB_TOKEN) —
	// never literal values, only name+key references.
	// +optional
	SecretEnv []SecretEnvVar `json:"secretEnv,omitempty"`

	// resources are the Job container's compute resource requirements.
	// +optional
	Resources ResourceRequirements `json:"resources,omitempty"`

	// timeoutSeconds is the default bound on the launched Job's
	// activeDeadlineSeconds, used when a ToolRun does not specify its own
	// timeoutSeconds. Lets long-running tools (e.g. an agentic coding tool)
	// raise the 300s default without every caller having to set it. When both
	// are unset the controller falls back to 300s.
	// +optional
	// +kubebuilder:validation:Minimum=1
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`
}

// ToolStatus defines the observed state of Tool.
type ToolStatus struct {
	// INSERT ADDITIONAL STATUS FIELD - define observed state of cluster
	// Important: Run "make" to regenerate code after modifying this file

	// For Kubernetes API conventions, see:
	// https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	// conditions represent the current state of the Tool resource.
	// Each condition has a unique type and reflects the status of a specific aspect of the resource.
	//
	// Standard condition types include:
	// - "Available": the resource is fully functional
	// - "Progressing": the resource is being created or updated
	// - "Degraded": the resource failed to reach or maintain its desired state
	//
	// The status of each condition is one of True, False, or Unknown.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// Tool is the Schema for the tools API
type Tool struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Tool
	// +required
	Spec ToolSpec `json:"spec"`

	// status defines the observed state of Tool
	// +optional
	Status ToolStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ToolList contains a list of Tool
type ToolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Tool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Tool{}, &ToolList{})
}
