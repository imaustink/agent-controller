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

// SecretKeySelector references a single key in a Secret, in the SAME namespace
// as the ToolRun. Never carry the secret value itself in the spec.
type SecretKeySelector struct {
	// name of the Secret.
	// +required
	Name string `json:"name"`

	// key within the Secret's data.
	// +required
	Key string `json:"key"`
}

// ToolRunCallback describes where/how the launched Job reports results.
// Exactly one delivery mode must be configured per ToolRun: HTTP callback
// (set url + secretRef) or NATS (set natsSubject + natsUrl). When
// natsSubject is non-empty the NATS path is used and url/secretRef are
// ignored; when natsSubject is empty the HTTP callback path is used and
// url/secretRef are required.
type ToolRunCallback struct {
	// url is the in-cluster HTTP callback receiver endpoint, e.g.
	// http://agent-orchestrator-callback.controller-agent.svc.cluster.local:8080
	// Required when natsSubject is empty.
	// +optional
	URL string `json:"url,omitempty"`

	// secretRef selects the HMAC signing secret injected as RECIPE_CALLBACK_SECRET
	// into the Job container's environment via secretKeyRef — never copied into
	// the ToolRun spec/status in plaintext.
	// Required when natsSubject is empty.
	// +optional
	SecretRef SecretKeySelector `json:"secretRef,omitempty"`

	// natsSubject is the NATS subject the Job should publish its result events to,
	// e.g. "callbacks.550e8400-e29b-41d4-a716-446655440000". When set, the Job
	// uses RECIPE_TRANSPORT=nats instead of the HTTP callback path.
	// +optional
	NatsSubject string `json:"natsSubject,omitempty"`

	// natsUrl is the NATS server URL the Job should connect to, e.g.
	// "nats://nats.controller-agent.svc.cluster.local:4222". Required when
	// natsSubject is set.
	// +optional
	NatsUrl string `json:"natsUrl,omitempty"`
}

// ToolRunSpec defines the desired state of ToolRun. The orchestrator creates one
// of these per tool invocation instead of creating a Job directly (ADR 0010) —
// the controller owns all Job creation/RBAC.
type ToolRunSpec struct {
	// toolRef is the name of the Tool CR (same namespace) describing the image/
	// serviceAccount/args/env to launch.
	// +required
	ToolRef string `json:"toolRef"`

	// args are the caller-supplied invocation arguments (e.g. the source URL),
	// appended after the Tool's static args.
	// +optional
	Args []string `json:"args,omitempty"`

	// callback configures result/progress reporting for the launched Job.
	// +required
	Callback ToolRunCallback `json:"callback"`

	// timeoutSeconds bounds the Job's activeDeadlineSeconds. Defaults to 300 if unset.
	// +optional
	// +kubebuilder:validation:Minimum=1
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`
}

// ToolRunPhase is the coarse lifecycle state of a ToolRun, mirrored from its
// owned Job. This (not the callback payload) is the source of truth for
// success/failure/timeout per the hybrid result-reporting decision (ADR 0010).
// +kubebuilder:validation:Enum=Pending;Running;Succeeded;Failed
type ToolRunPhase string

const (
	ToolRunPhasePending   ToolRunPhase = "Pending"
	ToolRunPhaseRunning   ToolRunPhase = "Running"
	ToolRunPhaseSucceeded ToolRunPhase = "Succeeded"
	ToolRunPhaseFailed    ToolRunPhase = "Failed"
)

// ToolRunStatus defines the observed state of ToolRun.
type ToolRunStatus struct {
	// phase is the coarse lifecycle state, derived from the owned Job's status.
	// +optional
	Phase ToolRunPhase `json:"phase,omitempty"`

	// jobName is the name of the Job this ToolRun created.
	// +optional
	JobName string `json:"jobName,omitempty"`

	// startTime is when the owned Job started.
	// +optional
	StartTime *metav1.Time `json:"startTime,omitempty"`

	// completionTime is when the owned Job finished (succeeded or failed).
	// +optional
	CompletionTime *metav1.Time `json:"completionTime,omitempty"`

	// message is a human-readable explanation of the current phase (e.g. failure reason).
	// +optional
	Message string `json:"message,omitempty"`

	// conditions represent the current state of the ToolRun resource.
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

// ToolRun is the Schema for the toolruns API
type ToolRun struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of ToolRun
	// +required
	Spec ToolRunSpec `json:"spec"`

	// status defines the observed state of ToolRun
	// +optional
	Status ToolRunStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ToolRunList contains a list of ToolRun
type ToolRunList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []ToolRun `json:"items"`
}

func init() {
	SchemeBuilder.Register(&ToolRun{}, &ToolRunList{})
}
