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

// AgentSpec defines the desired state of Agent. An Agent is a full agent
// loop launched as a one-shot Job (same execution architecture as Tool):
// given a goal at run time (AgentRun.spec.goal), it iterates internally and
// reports a final response over the same callback protocol tools use. The
// catalog half of the spec (description/input/output/allowedRoles/tier)
// mirrors ToolSpec so agents participate in the same RBAC-scoped RAG
// retrieval; the launch half (image/serviceAccountName/env) mirrors it too.
type AgentSpec struct {
	// description is fed to the orchestrator's embedder for RAG retrieval.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// input describes the goal contract this agent expects, in plain language.
	// +required
	Input string `json:"input"`

	// output describes the final response shape the agent reports.
	// +required
	Output string `json:"output"`

	// allowedRoles gates RAG retrieval (RBAC filter), same semantics as Tool.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// tier is an operator-defined cost/trust classification.
	// +optional
	Tier string `json:"tier,omitempty"`

	// image is the agent-loop container the AgentRun controller launches as a
	// Job (e.g. the agent-orchestrator image running in scoped sub-agent mode).
	// +required
	Image string `json:"image"`

	// serviceAccountName the Job pod runs as. Must already exist in-cluster.
	// +required
	ServiceAccountName string `json:"serviceAccountName"`

	// env are static, non-secret environment variables for the Job container.
	// +optional
	Env []EnvVar `json:"env,omitempty"`

	// secretEnv are environment variables sourced from Secret keys (same
	// namespace), resolved via secretKeyRef at Job-build time — same
	// discipline as ToolSpec.SecretEnv (never a literal secret in the CR).
	// +optional
	SecretEnv []SecretEnvVar `json:"secretEnv,omitempty"`

	// resources are the Job container's compute resource requirements.
	// +optional
	Resources ResourceRequirements `json:"resources,omitempty"`

	// skillRefs are the names of Skill CRs this agent may load into its own
	// loop (same trust model as the parent orchestrator's skill layer).
	// +optional
	SkillRefs []string `json:"skillRefs,omitempty"`

	// model is the LLM model id the agent loop should use (advisory; the
	// agent image decides how to interpret it).
	// +optional
	Model string `json:"model,omitempty"`

	// maxIterations bounds the agent's internal loop as a cost/runaway guard.
	// +optional
	// +kubebuilder:validation:Minimum=1
	MaxIterations int32 `json:"maxIterations,omitempty"`
}

// AgentStatus defines the observed state of Agent.
type AgentStatus struct {
	// INSERT ADDITIONAL STATUS FIELD - define observed state of cluster
	// Important: Run "make" to regenerate code after modifying this file

	// For Kubernetes API conventions, see:
	// https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	// conditions represent the current state of the Agent resource.
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

// Agent is the Schema for the agents API
type Agent struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Agent
	// +required
	Spec AgentSpec `json:"spec"`

	// status defines the observed state of Agent
	// +optional
	Status AgentStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AgentList contains a list of Agent
type AgentList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Agent `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Agent{}, &AgentList{})
}
