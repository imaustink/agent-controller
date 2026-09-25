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

// Package sandboxapi is a minimal, hand-maintained mirror of the subset of
// kubernetes-sigs/agent-sandbox's agents.x-k8s.io/v1beta1 API that the
// Sandbox execution backend reads and writes.
//
// Why a mirror instead of importing sigs.k8s.io/agent-sandbox: the upstream
// module requires k8s.io/* v0.37 and controller-runtime v0.25, while this
// controller is on v0.35 / v0.23.3. Taking the real dependency upgrades both
// transitively, which is a change worth making deliberately rather than as a
// side effect of a prototype. The JSON tags here are copied verbatim from
// upstream, so the wire representation is identical and swapping in the real
// types later is a type-name change with no behavioral difference.
//
// Fields upstream defines that we neither set nor read (volumeClaimTemplates,
// status.serviceFQDN, status.selector, ...) are deliberately omitted: this
// type is only ever used to create Sandboxes and to read their conditions,
// and omitted fields round-trip untouched because the API server, not this
// client, is the source of truth for the stored object.
package sandboxapi

import (
	"maps"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	// GroupVersion is the group/version of the upstream agent-sandbox API.
	GroupVersion = schema.GroupVersion{Group: "agents.x-k8s.io", Version: "v1beta1"}

	// SchemeBuilder registers Sandbox/SandboxList into a runtime.Scheme.
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}

	// AddToScheme adds the types in this package to a scheme.
	AddToScheme = SchemeBuilder.AddToScheme
)

func init() {
	SchemeBuilder.Register(&Sandbox{}, &SandboxList{})
}

// Condition types and reasons we depend on, copied from upstream.
const (
	// ConditionReady reports whether the backing Pod is Running+Ready with an
	// assigned IP. Upstream is explicit that there is deliberately no separate
	// "Running" condition; readiness subsumes it.
	ConditionReady = "Ready"
	// ConditionFinished is set only once the backing Pod reached a terminal
	// phase, with the reason recording which. This is the Sandbox analogue of
	// Job.status.succeeded/failed and is what preserves ADR 0010's rule that
	// the workload's own status, not the callback payload, decides the run's
	// terminal phase.
	ConditionFinished = "Finished"
	// ConditionSuspended reports progress of an administrative suspension.
	ConditionSuspended = "Suspended"

	// ReasonPodSucceeded / ReasonPodFailed are the Finished condition's reasons.
	ReasonPodSucceeded = "PodSucceeded"
	ReasonPodFailed    = "PodFailed"

	// ReasonSandboxExpired is a Ready=False reason set when the Sandbox passed
	// its shutdownTime and its resources were torn down. This is how a
	// Sandbox-backed run reports the timeout that a Job reports through
	// activeDeadlineSeconds.
	ReasonSandboxExpired = "SandboxExpired"
	// ReasonSuspended is a Ready=False reason set while administratively suspended.
	ReasonSuspended = "SandboxSuspended"
)

// SandboxOperatingMode is the desired operational state of a Sandbox.
//
// Deliberately carries no kubebuilder markers. This package mirrors an API
// owned by kubernetes-sigs/agent-sandbox; generating a CRD from it would ship
// a second, partial definition of agents.x-k8s.io/v1beta1 Sandbox that
// collides with the real one on install.
type SandboxOperatingMode string

const (
	// OperatingModeRunning keeps a backing Pod running.
	OperatingModeRunning SandboxOperatingMode = "Running"
	// OperatingModeSuspended terminates the backing Pod while retaining the
	// Sandbox object and its volumes, so it can be resumed later.
	OperatingModeSuspended SandboxOperatingMode = "Suspended"
)

// ShutdownPolicy governs what happens to the Sandbox object itself on expiry.
type ShutdownPolicy string

const (
	// ShutdownPolicyDelete deletes the Sandbox object once its resources are removed.
	ShutdownPolicyDelete ShutdownPolicy = "Delete"
	// ShutdownPolicyRetain keeps the Sandbox object, with Ready=False/SandboxExpired,
	// so the expiry stays observable. This is what the run backend wants: a
	// timed-out run must remain readable long enough for the reconciler to
	// record a terminal phase.
	ShutdownPolicyRetain ShutdownPolicy = "Retain"
)

// PodMetadata is the labels/annotations subset of ObjectMeta that upstream
// propagates onto the backing Pod.
type PodMetadata struct {
	Labels      map[string]string `json:"labels,omitempty"`
	Annotations map[string]string `json:"annotations,omitempty"`
}

// PodTemplate describes the Pod the Sandbox controller will create.
type PodTemplate struct {
	Spec       corev1.PodSpec `json:"spec"`
	ObjectMeta PodMetadata    `json:"metadata,omitempty"`
}

// SandboxSpec is the desired state of a Sandbox. Upstream inlines its
// Lifecycle struct, so shutdownTime/shutdownPolicy are top-level in JSON.
type SandboxSpec struct {
	PodTemplate PodTemplate `json:"podTemplate"`

	// Service controls whether the controller creates a headless Service.
	// A one-shot tool run needs no inbound addressing, so the backend sets
	// this false explicitly rather than leaving it unset (unset preserves a
	// pre-existing Service for backward compatibility).
	Service *bool `json:"service,omitempty"`

	// ShutdownTime is the absolute time the Sandbox expires. The Job backend's
	// activeDeadlineSeconds is a duration from start; this is a wall-clock
	// instant, so the backend computes it at build time.
	ShutdownTime *metav1.Time `json:"shutdownTime,omitempty"`

	// ShutdownPolicy governs the Sandbox object on expiry.
	ShutdownPolicy *ShutdownPolicy `json:"shutdownPolicy,omitempty"`

	// OperatingMode declares Running or Suspended. Defaults to Running.
	OperatingMode SandboxOperatingMode `json:"operatingMode,omitempty"`
}

// SandboxStatus is the observed state of a Sandbox.
type SandboxStatus struct {
	Service    string             `json:"service,omitempty"`
	Conditions []metav1.Condition `json:"conditions,omitempty"`
	PodIPs     []string           `json:"podIPs,omitempty"`
	NodeName   string             `json:"nodeName,omitempty"`
}

// Sandbox is a single stateful pod with a stable identity, suspendable in place.
type Sandbox struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   SandboxSpec   `json:"spec"`
	Status SandboxStatus `json:"status,omitempty"`
}

// SandboxList is a list of Sandboxes.
type SandboxList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []Sandbox `json:"items"`
}

// DeepCopyInto / DeepCopyObject are hand-written rather than generated,
// because controller-gen is wired to api/v1alpha1 only and this package is a
// vendored mirror that should not participate in CRD generation.

func (in *PodMetadata) DeepCopyInto(out *PodMetadata) {
	*out = *in
	if in.Labels != nil {
		out.Labels = make(map[string]string, len(in.Labels))
		maps.Copy(out.Labels, in.Labels)
	}
	if in.Annotations != nil {
		out.Annotations = make(map[string]string, len(in.Annotations))
		maps.Copy(out.Annotations, in.Annotations)
	}
}

func (in *PodTemplate) DeepCopyInto(out *PodTemplate) {
	*out = *in
	in.Spec.DeepCopyInto(&out.Spec)
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
}

func (in *SandboxSpec) DeepCopyInto(out *SandboxSpec) {
	*out = *in
	in.PodTemplate.DeepCopyInto(&out.PodTemplate)
	if in.Service != nil {
		v := *in.Service
		out.Service = &v
	}
	if in.ShutdownTime != nil {
		out.ShutdownTime = in.ShutdownTime.DeepCopy()
	}
	if in.ShutdownPolicy != nil {
		p := *in.ShutdownPolicy
		out.ShutdownPolicy = &p
	}
}

func (in *SandboxStatus) DeepCopyInto(out *SandboxStatus) {
	*out = *in
	if in.Conditions != nil {
		out.Conditions = make([]metav1.Condition, len(in.Conditions))
		for i := range in.Conditions {
			in.Conditions[i].DeepCopyInto(&out.Conditions[i])
		}
	}
	if in.PodIPs != nil {
		out.PodIPs = make([]string, len(in.PodIPs))
		copy(out.PodIPs, in.PodIPs)
	}
}

func (in *Sandbox) DeepCopyInto(out *Sandbox) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ObjectMeta.DeepCopyInto(&out.ObjectMeta)
	in.Spec.DeepCopyInto(&out.Spec)
	in.Status.DeepCopyInto(&out.Status)
}

func (in *Sandbox) DeepCopy() *Sandbox {
	if in == nil {
		return nil
	}
	out := new(Sandbox)
	in.DeepCopyInto(out)
	return out
}

func (in *Sandbox) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}

func (in *SandboxList) DeepCopyInto(out *SandboxList) {
	*out = *in
	out.TypeMeta = in.TypeMeta
	in.ListMeta.DeepCopyInto(&out.ListMeta)
	if in.Items != nil {
		out.Items = make([]Sandbox, len(in.Items))
		for i := range in.Items {
			in.Items[i].DeepCopyInto(&out.Items[i])
		}
	}
}

func (in *SandboxList) DeepCopy() *SandboxList {
	if in == nil {
		return nil
	}
	out := new(SandboxList)
	in.DeepCopyInto(out)
	return out
}

func (in *SandboxList) DeepCopyObject() runtime.Object {
	if c := in.DeepCopy(); c != nil {
		return c
	}
	return nil
}
