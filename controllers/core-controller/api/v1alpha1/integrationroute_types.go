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

// IntegrationRouteMatch selects which inbound integration-gateway events a
// route applies to. Matching is exact (no globs/regex) — deliberately small
// per docs/integrations-gateway.md's non-goal of a full rules engine.
type IntegrationRouteMatch struct {
	// source is the adapter that produced the event (e.g. "github").
	// +required
	// +kubebuilder:validation:MinLength=1
	Source string `json:"source"`

	// event is the adapter-specific event name (e.g. "issues").
	// +required
	// +kubebuilder:validation:MinLength=1
	Event string `json:"event"`

	// action is the adapter-specific sub-action (e.g. "assigned"). Omitted
	// matches any action for this source/event pair.
	// +optional
	Action string `json:"action,omitempty"`
}

// IntegrationRouteSpec defines a declarative mapping from an inbound
// integration-gateway event to a target Skill/Agent/Tool plus the prompt to
// invoke it with, so a specific trigger (e.g. a GitHub issue being assigned
// to the bot) can be dispatched deterministically instead of relying on RAG
// skill retrieval to infer intent from free text (docs/integrations-gateway.md,
// "Open Questions" — the IntegrationRoute CRD this resolves).
//
// When agent-orchestrator's /invoke receives an event descriptor matching a
// route, it renders promptTemplate and dispatches directly to the
// referenced Skill/Agent/Tool, bypassing retrieval. No matching route falls
// back to today's RAG-based behavior unchanged.
// +kubebuilder:validation:XValidation:rule="(has(self.skillRef)?1:0)+(has(self.agentRef)?1:0)+(has(self.toolRef)?1:0)==1",message="exactly one of skillRef, agentRef, or toolRef must be set"
type IntegrationRouteSpec struct {
	// match selects which inbound events this route applies to.
	// +required
	Match IntegrationRouteMatch `json:"match"`

	// skillRef names a Skill CR (same namespace) to dispatch to. Exactly one
	// of skillRef/agentRef/toolRef must be set.
	// +optional
	SkillRef string `json:"skillRef,omitempty"`

	// agentRef names an Agent CR (same namespace) to dispatch to directly
	// (docs/adr/0021), same as a Skill's agentRefs. Exactly one of
	// skillRef/agentRef/toolRef must be set.
	// +optional
	AgentRef string `json:"agentRef,omitempty"`

	// toolRef names a Tool CR (same namespace) to dispatch to. Exactly one
	// of skillRef/agentRef/toolRef must be set.
	// +optional
	ToolRef string `json:"toolRef,omitempty"`

	// promptTemplate is the request sent to the target, rendered by
	// substituting `{{field}}` placeholders with the matched event's fields
	// (e.g. owner, repo, issueNumber, title, body, senderLogin,
	// assigneeLogin — the exact set depends on the adapter that produced
	// the event).
	// +required
	// +kubebuilder:validation:MinLength=1
	PromptTemplate string `json:"promptTemplate"`
}

// IntegrationRouteStatus defines the observed state of IntegrationRoute.
type IntegrationRouteStatus struct {
	// INSERT ADDITIONAL STATUS FIELD - define observed state of cluster
	// Important: Run "make" to regenerate code after modifying this file

	// For Kubernetes API conventions, see:
	// https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	// conditions represent the current state of the IntegrationRoute resource.
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

// IntegrationRoute is the Schema for the integrationroutes API
type IntegrationRoute struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of IntegrationRoute
	// +required
	Spec IntegrationRouteSpec `json:"spec"`

	// status defines the observed state of IntegrationRoute
	// +optional
	Status IntegrationRouteStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// IntegrationRouteList contains a list of IntegrationRoute
type IntegrationRouteList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []IntegrationRoute `json:"items"`
}

func init() {
	SchemeBuilder.Register(&IntegrationRoute{}, &IntegrationRouteList{})
}
