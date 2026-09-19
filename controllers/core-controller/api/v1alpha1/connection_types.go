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

// ConnectionScope names the bounded set of resources this Connection reaches.
// Exactly one field is set, and which one is determined by the provider (see
// the CEL rules on ConnectionSpec).
//
// This is the security boundary of a Connection (ADR 0038): everything the
// connection-broker does — syncing, and the GET face — is constrained to it,
// and a driver that widened it would silently cross a client boundary. It is
// therefore validated at ADMISSION rather than left to the driver at run time.
type ConnectionScope struct {
	// space is a Confluence space key (e.g. "SNC").
	// +optional
	// +kubebuilder:validation:MinLength=1
	Space string `json:"space,omitempty"`

	// channel is a Slack channel id (e.g. "C6RQKL5BK"). An id, not a name:
	// names are mutable and a renamed channel must not silently re-point a
	// connection at different material.
	// +optional
	// +kubebuilder:validation:MinLength=1
	Channel string `json:"channel,omitempty"`

	// folderID is a Google Drive folder id. Contents are synced recursively.
	// +optional
	// +kubebuilder:validation:MinLength=1
	FolderID string `json:"folderID,omitempty"`
}

// ConnectionSyncMode selects how a Connection learns that its resources changed.
// +kubebuilder:validation:Enum=webhook;poll;none
type ConnectionSyncMode string

const (
	// ConnectionSyncWebhook registers a provider webhook for low-latency
	// updates. It does NOT remove the need for reconcileInterval — every one
	// of these notification channels is lossy (ADR 0038 §4).
	ConnectionSyncWebhook ConnectionSyncMode = "webhook"

	// ConnectionSyncPoll relies on the reconcile pass alone.
	ConnectionSyncPoll ConnectionSyncMode = "poll"

	// ConnectionSyncNone indexes nothing; the Connection exists only for its
	// GET face.
	ConnectionSyncNone ConnectionSyncMode = "none"
)

// ConnectionBackfill bounds the initial historical read.
type ConnectionBackfill struct {
	// since is the oldest resource to ingest on first sync. Omitted means
	// everything the provider will give us, which for a long-lived Slack
	// channel can be a great deal.
	// +optional
	Since *metav1.Time `json:"since,omitempty"`
}

// ConnectionSync configures how this Connection is kept current.
//
// reconcileInterval is required whatever the mode, because the full reconcile
// — not the webhook stream — is the source of truth (ADR 0038 §4). Drive push
// channels expire, Slack drops events with no replay, and a Confluence webhook
// can be disabled by a space admin; a corpus that is correct only if no event
// was ever missed is a corpus nobody can trust. Deletions likewise resolve at
// reconcile even when their event never arrived.
type ConnectionSync struct {
	// mode selects the change-notification strategy.
	// +required
	Mode ConnectionSyncMode `json:"mode"`

	// reconcileInterval is how often a full reconcile pass runs. Required even
	// for mode "webhook" (see the type doc); ignored for mode "none".
	// +optional
	ReconcileInterval *metav1.Duration `json:"reconcileInterval,omitempty"`

	// backfill bounds the initial historical read.
	// +optional
	Backfill *ConnectionBackfill `json:"backfill,omitempty"`
}

// ConnectionAPIMethod is an HTTP method the live face may issue.
// +kubebuilder:validation:Enum=GET
type ConnectionAPIMethod string

// ConnectionAPIMethodGet is the only method allowed in v1alpha1.
const ConnectionAPIMethodGet ConnectionAPIMethod = "GET"

// ConnectionAPI configures the live face (ADR 0038 §5): a generated
// `conn:<name>/get` tool that reads the CURRENT state of a resource, which
// retrieval (as of the last sync) cannot.
//
// Three limits make it safe, and only the first is expressed here — the other
// two belong to the driver, which is the only thing that can enforce them:
// a driver-declared path allowlist, and proof that the request stays inside
// spec.scope.
type ConnectionAPI struct {
	// enabled turns the live face on. Default false: a Connection that only
	// feeds a knowledge base needs no callable surface.
	// +optional
	// +kubebuilder:default=false
	Enabled bool `json:"enabled,omitempty"`

	// methods the live face may issue. v1alpha1 allows GET only — writes need
	// an authorization story this API does not yet have, and this field exists
	// so that story has somewhere to land.
	// +optional
	// +kubebuilder:default={GET}
	Methods []ConnectionAPIMethod `json:"methods,omitempty"`
}

// ConnectionSpec defines the desired state of Connection.
//
// A Connection is ONE SCOPED SUBSET of an external system — this Confluence
// space, this Slack channel, this Drive folder — plus the credential that
// reaches it (ADR 0038). Several Connections of the same provider are ordinary:
// two Slack channels are two Connections pointing at the same Secret.
//
// Scope validation is per-provider and strict. Each rule is written separately
// rather than as one disjunction so a mismatch reports which provider it
// violated.
// +kubebuilder:validation:XValidation:rule="self.provider != 'confluence' || (has(self.scope.space) && !has(self.scope.channel) && !has(self.scope.folderID))",message="a confluence Connection must set scope.space and nothing else"
// +kubebuilder:validation:XValidation:rule="self.provider != 'slack' || (has(self.scope.channel) && !has(self.scope.space) && !has(self.scope.folderID))",message="a slack Connection must set scope.channel and nothing else"
// +kubebuilder:validation:XValidation:rule="self.provider != 'gdrive' || (has(self.scope.folderID) && !has(self.scope.space) && !has(self.scope.channel))",message="a gdrive Connection must set scope.folderID and nothing else"
// +kubebuilder:validation:XValidation:rule="!has(self.sync) || self.sync.mode == 'none' || has(self.sync.reconcileInterval)",message="sync.reconcileInterval is required unless sync.mode is none: webhooks are lossy and the reconcile pass is the source of truth"
type ConnectionSpec struct {
	// provider selects the driver that knows how to list, fetch, watch and
	// call this system. Adding a provider is an implementation of the driver
	// interface, not a new CRD.
	// +required
	// +kubebuilder:validation:Enum=confluence;slack;gdrive
	Provider string `json:"provider"`

	// description is fed to the orchestrator's embedder for the generated
	// `conn:<name>/get` tool, and tells the planner what this connection holds.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// displayName is what citations render (e.g. "#snc-eng"). Two Connections
	// of the same provider inside one KnowledgeBase need distinct values, or a
	// cited answer cannot say which channel it came from. Defaults to
	// metadata.name.
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	// allowedRoles gates retrieval and invocation (RBAC filter) — a caller must
	// hold at least one. Every chunk this Connection contributes to a
	// KnowledgeBase is written with these roles and filtered on them at read
	// time, which is what lets one corpus safely mix Connections of differing
	// sensitivity.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// tier is an operator-defined cost/trust classification (e.g. "standard",
	// "privileged"), as on Tool.
	// +optional
	Tier string `json:"tier,omitempty"`

	// scope bounds the resources this Connection reaches. See ConnectionScope.
	// +required
	Scope ConnectionScope `json:"scope"`

	// secretEnv are environment variables sourced from Secret keys in the same
	// namespace (never literal values), resolved by the connection-broker.
	// Two Connections over the same system share one Secret.
	//
	// Per-user delegated credentials (Tool.spec.identityProviders, ADR 0032)
	// are deliberately absent in v1alpha1: a scheduled reconcile has no calling
	// user, so a per-user sync is incoherent as stated (ADR 0038 §7).
	// +optional
	SecretEnv []SecretEnvVar `json:"secretEnv,omitempty"`

	// sync configures how this Connection is kept current. Omitted means no
	// indexing at all — a live-face-only Connection.
	// +optional
	Sync *ConnectionSync `json:"sync,omitempty"`

	// api configures the live face.
	// +optional
	API *ConnectionAPI `json:"api,omitempty"`
}

// ConnectionWebhookStatus reports the provider-side subscription.
//
// expiresAt matters operationally: a Google Drive push channel lapses after
// about a week, and a silently expired channel degrades this Connection to its
// reconcile interval — correct, but slower than anyone expects.
type ConnectionWebhookStatus struct {
	// registered is true while a provider subscription is believed live.
	// +optional
	Registered bool `json:"registered,omitempty"`

	// expiresAt is when the provider will stop delivering unless renewed.
	// +optional
	ExpiresAt *metav1.Time `json:"expiresAt,omitempty"`
}

// ConnectionStatus defines the observed state of Connection.
type ConnectionStatus struct {
	// collection is the vector-store collection this Connection owns. Storage
	// is per-Connection rather than per-KnowledgeBase so that a Connection
	// shared by several knowledge bases is embedded once, and recomposing a
	// knowledge base costs no re-indexing (ADR 0039 §1).
	// +optional
	Collection string `json:"collection,omitempty"`

	// resources is how many resources were indexed as of the last sync.
	// +optional
	Resources int64 `json:"resources,omitempty"`

	// lastSyncTime is the last successful sync of any kind, including a
	// webhook-triggered partial one.
	// +optional
	LastSyncTime *metav1.Time `json:"lastSyncTime,omitempty"`

	// lastReconcileTime is the last successful FULL reconcile. Because the
	// reconcile pass is the source of truth (ADR 0038 §4), this — not
	// lastSyncTime — is how stale the corpus may actually be.
	// +optional
	LastReconcileTime *metav1.Time `json:"lastReconcileTime,omitempty"`

	// webhook reports the provider-side subscription, when mode is "webhook".
	// +optional
	Webhook *ConnectionWebhookStatus `json:"webhook,omitempty"`

	// observedGeneration is the .metadata.generation this status reflects.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// conditions represent the current state of the Connection resource.
	// This controller uses "Ready" to report spec validity and "Synced" to
	// report whether the corpus is current.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=".spec.provider"
// +kubebuilder:printcolumn:name="Resources",type=integer,JSONPath=".status.resources"
// +kubebuilder:printcolumn:name="Last Reconcile",type=date,JSONPath=".status.lastReconcileTime"
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=".status.conditions[?(@.type=='Ready')].status"

// Connection is the Schema for the connections API
type Connection struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Connection
	// +required
	Spec ConnectionSpec `json:"spec"`

	// status defines the observed state of Connection
	// +optional
	Status ConnectionStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ConnectionList contains a list of Connection
type ConnectionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Connection `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Connection{}, &ConnectionList{})
}
