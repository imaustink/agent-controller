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

// SkillSpec defines the desired state of Skill. Fields mirror the JS orchestrator's
// former static catalog.ts SkillDescriptor entries (ADR 0008), now hand-authored
// CRs instead of requiring an image rebuild to change.
type SkillSpec struct {
	// description is fed to the orchestrator's embedder for RAG skill retrieval.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// input describes what a caller should provide when this skill applies,
	// in plain language. Purely descriptive (better RAG matching, parity with
	// Tool/Agent) — a Skill itself is never executed as a pod.
	// +optional
	Input string `json:"input,omitempty"`

	// output describes what interactions under this skill produce, in plain
	// language. Purely descriptive, like input.
	// +optional
	Output string `json:"output,omitempty"`

	// markdown is injected as trusted system-prompt context for the action planner.
	// Unlike tool descriptions (semi-trusted, catalog data), this is treated as
	// operator-authored instructions.
	// +required
	Markdown string `json:"markdown"`

	// toolRefs are the names of Tool CRs this skill is permitted to invoke. The
	// action planner's chosen toolId is re-validated against this list before
	// a ToolRun is ever created. May be empty for respond-only skills (pure
	// system-prompt knowledge, no tool calls).
	//
	// Note a Skill deliberately carries NO allowedRoles of its own (ADR 0011):
	// skills are trusted markdown, not capability — all RBAC lives on the
	// dangerous things (Tool/Agent). A skill's effective audience is derived
	// by the orchestrator as the intersection of its tools' allowedRoles
	// (unrestricted when toolRefs is empty).
	// +optional
	ToolRefs []string `json:"toolRefs,omitempty"`
}

// SkillStatus defines the observed state of Skill.
type SkillStatus struct {
	// INSERT ADDITIONAL STATUS FIELD - define observed state of cluster
	// Important: Run "make" to regenerate code after modifying this file

	// For Kubernetes API conventions, see:
	// https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	// conditions represent the current state of the Skill resource.
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

// Skill is the Schema for the skills API
type Skill struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Skill
	// +required
	Spec SkillSpec `json:"spec"`

	// status defines the observed state of Skill
	// +optional
	Status SkillStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// SkillList contains a list of Skill
type SkillList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Skill `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Skill{}, &SkillList{})
}
