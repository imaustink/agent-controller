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
	// by the orchestrator as the intersection of its tools' AND agents'
	// allowedRoles (unrestricted when both toolRefs and agentRefs are empty).
	// +optional
	ToolRefs []string `json:"toolRefs,omitempty"`

	// agentRefs are the names of Agent CRs this skill is permitted to
	// delegate to directly (docs/adr/0021) — dispatched as an AgentRun the
	// same way an agent-backed Tool (Tool.spec.agentRef) already is, but
	// without needing a Tool CR to wrap the Agent first. Combined with
	// toolRefs for both RBAC derivation (ADR 0011) and what the action
	// planner may select from. May be empty for skills that call only tools
	// (or neither, for a respond-only skill).
	// +optional
	AgentRefs []string `json:"agentRefs,omitempty"`

	// allowedPrincipals privately scopes this Skill to a specific set of users
	// (ABAC, docs/adr/0037). Unlike Tool/Agent, a Skill carries no allowedRoles
	// of its own (ADR 0011) — its RBAC audience is DERIVED from the tools/agents
	// it references. ABAC private-scoping is the one access marker a Skill may
	// carry directly, because it is an explicit owner intent ("only these
	// users") rather than a capability grant.
	//
	// When empty (the default) the Skill inherits any private-scoping of the
	// tools/agents it references: the orchestrator intersects the
	// allowedPrincipals of every referenced tool/agent that is itself private,
	// so a Skill can never widen a private tool's audience. When non-empty it
	// is additionally intersected with that inherited set, restricting the
	// Skill to callers whose resolved principal (docs/adr/0030 §6) appears in
	// the result. Enforced by the orchestrator at index/query time
	// (derive-access.ts), never by this controller.
	// +optional
	AllowedPrincipals []string `json:"allowedPrincipals,omitempty"`

	// allowCallerTools controls whether tools supplied by the CONSUMER in the
	// request body (docs/adr/0035 — `/v1/chat/completions`'s `tools` array,
	// executed by the caller's own client rather than by this cluster) may be
	// offered to the action planner alongside this skill's own toolRefs/agentRefs.
	//
	// Unset means ALLOWED. The default that matches the OpenAI wire contract is
	// "the tools I sent are usable"; a skill whose markdown encodes an exact,
	// auditable procedure is the exception that turns them off. That's why this is
	// a pointer — a plain bool's zero value would silently mean "refuse" on every
	// existing Skill CR.
	//
	// This is NOT an authorization boundary and must not be relied on as one: it
	// keeps an authored skill's tool loop predictable, nothing more. Caller tools
	// carry no RBAC because the caller both supplies and executes them (the
	// orchestrator never gains a capability from one).
	// +optional
	AllowCallerTools *bool `json:"allowCallerTools,omitempty"`
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
