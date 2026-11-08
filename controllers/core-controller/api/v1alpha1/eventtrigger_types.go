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

// EventTriggerMatch selects events by a CEL predicate over the envelope
// (docs/event-triggers.md §3).
type EventTriggerMatch struct {
	// cel must evaluate to bool. Absent matches every event from sourceRef.
	// +optional
	CEL string `json:"cel,omitempty"`
}

// OrchestratorTarget runs an ordinary conversational turn (skill retrieval)
// on the rendered prompt. It has no fields; its presence selects it.
type OrchestratorTarget struct{}

// EventTriggerTarget is exactly one of orchestrator/skillRef/agentRef/toolRef.
// +kubebuilder:validation:XValidation:rule="(has(self.orchestrator)?1:0)+(has(self.skillRef)?1:0)+(has(self.agentRef)?1:0)+(has(self.toolRef)?1:0)==1",message="exactly one of orchestrator, skillRef, agentRef or toolRef must be set"
// +kubebuilder:validation:XValidation:rule="has(self.toolRef) || (has(self.promptTemplate) && size(self.promptTemplate) > 0)",message="promptTemplate is required unless toolRef is set"
type EventTriggerTarget struct {
	// orchestrator runs a conversational turn on the rendered prompt.
	// +optional
	Orchestrator *OrchestratorTarget `json:"orchestrator,omitempty"`

	// skillRef forces a Skill CR (same namespace).
	// +optional
	SkillRef string `json:"skillRef,omitempty"`

	// agentRef dispatches an Agent CR (same namespace) as a subagent.
	// +optional
	AgentRef string `json:"agentRef,omitempty"`

	// toolRef runs a Tool CR (same namespace) once, with params as its
	// arguments, skipping the planner.
	// +optional
	ToolRef string `json:"toolRef,omitempty"`

	// promptTemplate is the request, with {{param}} placeholders.
	// +optional
	PromptTemplate string `json:"promptTemplate,omitempty"`

	// readOnly makes every AgentRun/ToolRun this turn launches read-only and
	// suppresses write credentials. It can only restrict.
	// +optional
	ReadOnly bool `json:"readOnly,omitempty"`
}

// GitHubReply posts to an issue or pull request. Every string is a
// {{param}} template.
type GitHubReply struct {
	// repository is "owner/name".
	// +required
	// +kubebuilder:validation:MinLength=1
	Repository string `json:"repository"`

	// issueNumber is the issue or pull request number.
	// +required
	// +kubebuilder:validation:MinLength=1
	IssueNumber string `json:"issueNumber"`

	// ack is a comment posted before the run starts.
	// +optional
	Ack string `json:"ack,omitempty"`

	// sessionPage appends a session-page link to the ack comment.
	// +optional
	SessionPage bool `json:"sessionPage,omitempty"`

	// result posts the turn's result as a comment.
	// +optional
	Result bool `json:"result,omitempty"`

	// removeLabel is removed when the run ends, on every outcome.
	// +optional
	RemoveLabel string `json:"removeLabel,omitempty"`
}

// HTTPReply POSTs the terminal outcome to a fixed URL.
type HTTPReply struct {
	// url is a literal, never templated: a reply target must come from
	// operator config, not from event content (SSRF).
	// +required
	// +kubebuilder:validation:Pattern=`^https?://`
	URL string `json:"url"`

	// secretRef signs the body (x-event-signature: sha256=<hex hmac>).
	// +optional
	SecretRef *SecretKeySelector `json:"secretRef,omitempty"`
}

// EventTriggerReply declares side effects executed by integration-gateway.
type EventTriggerReply struct {
	// +optional
	GitHub *GitHubReply `json:"github,omitempty"`

	// +optional
	HTTP *HTTPReply `json:"http,omitempty"`
}

// EventTriggerSpec defines what a matching event dispatches.
type EventTriggerSpec struct {
	// sourceRef restricts the trigger to one EventSource.
	// +optional
	SourceRef string `json:"sourceRef,omitempty"`

	// priority breaks ties when several triggers match; higher wins, then name.
	// +optional
	Priority int32 `json:"priority,omitempty"`

	// match selects events.
	// +optional
	Match EventTriggerMatch `json:"match,omitempty"`

	// params maps a name to a CEL expression evaluated against the envelope.
	// +optional
	Params map[string]string `json:"params,omitempty"`

	// sessionKey is a {{param}} template for the turn's session id.
	// +optional
	SessionKey string `json:"sessionKey,omitempty"`

	// target is what the event dispatches.
	// +required
	Target EventTriggerTarget `json:"target"`

	// reply declares side effects around the run.
	// +optional
	Reply *EventTriggerReply `json:"reply,omitempty"`
}

// EventTriggerStatus defines the observed state of EventTrigger.
type EventTriggerStatus struct {
	// conditions; "Ready" reports that the CEL compiles and refs resolve.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Source",type=string,JSONPath=".spec.sourceRef"
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// EventTrigger maps events matching a CEL predicate to an orchestrator turn,
// Skill, Agent or Tool with CEL-derived params (docs/adr/0048).
type EventTrigger struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of EventTrigger
	// +required
	Spec EventTriggerSpec `json:"spec"`

	// status defines the observed state of EventTrigger
	// +optional
	Status EventTriggerStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// EventTriggerList contains a list of EventTrigger
type EventTriggerList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []EventTrigger `json:"items"`
}

func init() {
	SchemeBuilder.Register(&EventTrigger{}, &EventTriggerList{})
}
