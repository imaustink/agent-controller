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

// AgentRunSpec defines the desired state of AgentRun. The orchestrator (or
// another caller) creates one per agent invocation — exactly the ToolRun
// pattern, but the payload is a natural-language `goal` rather than
// positional args, and the target is an Agent CR.
type AgentRunSpec struct {
	// agentRef is the name of the Agent CR (same namespace) to launch.
	// +required
	AgentRef string `json:"agentRef"`

	// goal is the scoped natural-language objective handed to the agent loop
	// (passed as the Job container's argument).
	// +required
	// +kubebuilder:validation:MinLength=1
	Goal string `json:"goal"`

	// callback configures result/progress reporting for the launched Job,
	// reusing the same HMAC callback protocol as ToolRun (ADR 0006/0010).
	// +required
	Callback ToolRunCallback `json:"callback"`

	// timeoutSeconds bounds the Job's activeDeadlineSeconds. Defaults to 300 if unset.
	// +optional
	// +kubebuilder:validation:Minimum=1
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`
}

// AgentRunStatus defines the observed state of AgentRun — identical shape
// and semantics to ToolRunStatus (the owned Job is the source of truth for
// lifecycle; result payloads flow over the callback protocol).
type AgentRunStatus struct {
	// phase is the coarse lifecycle state, derived from the owned Job's status.
	// +optional
	Phase ToolRunPhase `json:"phase,omitempty"`

	// jobName is the name of the Job this AgentRun created.
	// +optional
	JobName string `json:"jobName,omitempty"`

	// startTime is when the owned Job started.
	// +optional
	StartTime *metav1.Time `json:"startTime,omitempty"`

	// completionTime is when the owned Job finished (succeeded or failed).
	// +optional
	CompletionTime *metav1.Time `json:"completionTime,omitempty"`

	// message is a human-readable explanation of the current phase.
	// +optional
	Message string `json:"message,omitempty"`

	// conditions represent the current state of the AgentRun resource.
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
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Job",type=string,JSONPath=`.status.jobName`
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=`.metadata.creationTimestamp`

// AgentRun is the Schema for the agentruns API
type AgentRun struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of AgentRun
	// +required
	Spec AgentRunSpec `json:"spec"`

	// status defines the observed state of AgentRun
	// +optional
	Status AgentRunStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// AgentRunList contains a list of AgentRun
type AgentRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []AgentRun `json:"items"`
}

func init() {
	SchemeBuilder.Register(&AgentRun{}, &AgentRunList{})
}
