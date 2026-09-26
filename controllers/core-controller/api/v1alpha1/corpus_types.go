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

// CorpusScope names the bounded set of resources this Corpus reaches.
// Exactly one field is set, and which one is determined by the provider (see
// the CEL rules on CorpusSpec).
//
// This is the security boundary of a Corpus (ADR 0038): everything the
// connection-broker does — syncing, and the GET face — is constrained to it,
// and a driver that widened it would silently cross a client boundary. It is
// therefore validated at ADMISSION rather than left to the driver at run time.
type CorpusScope struct {
	// space is a Confluence space key (e.g. "GLOBEX").
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

// CorpusSyncMode selects how a Corpus learns that its resources changed.
// +kubebuilder:validation:Enum=webhook;poll;none
type CorpusSyncMode string

const (
	// CorpusSyncWebhook registers a provider webhook for low-latency
	// updates. It does NOT remove the need for reconcileInterval — every one
	// of these notification channels is lossy (ADR 0038 §4).
	CorpusSyncWebhook CorpusSyncMode = "webhook"

	// CorpusSyncPoll relies on the reconcile pass alone.
	CorpusSyncPoll CorpusSyncMode = "poll"

	// CorpusSyncNone indexes nothing; the Connection exists only for its
	// GET face.
	CorpusSyncNone CorpusSyncMode = "none"
)

// CorpusBackfill bounds the initial historical read.
type CorpusBackfill struct {
	// since is the oldest resource to ingest on first sync. Omitted means
	// everything the provider will give us, which for a long-lived Slack
	// channel can be a great deal.
	// +optional
	Since *metav1.Time `json:"since,omitempty"`
}

// CorpusSync configures how this Corpus is kept current.
//
// reconcileInterval is required whatever the mode, because the full reconcile
// — not the webhook stream — is the source of truth (ADR 0038 §4). Drive push
// channels expire, Slack drops events with no replay, and a Confluence webhook
// can be disabled by a space admin; a corpus that is correct only if no event
// was ever missed is a corpus nobody can trust. Deletions likewise resolve at
// reconcile even when their event never arrived.
type CorpusSync struct {
	// mode selects the change-notification strategy.
	// +required
	Mode CorpusSyncMode `json:"mode"`

	// reconcileInterval is how often a full reconcile pass runs. Required even
	// for mode "webhook" (see the type doc); ignored for mode "none".
	// +optional
	ReconcileInterval *metav1.Duration `json:"reconcileInterval,omitempty"`

	// backfill bounds the initial historical read.
	// +optional
	Backfill *CorpusBackfill `json:"backfill,omitempty"`
}

// CorpusAPIMethod is an HTTP method the live face may issue.
// +kubebuilder:validation:Enum=GET
type CorpusAPIMethod string

// CorpusAPIMethodGet is the only method allowed in v1alpha1.
const CorpusAPIMethodGet CorpusAPIMethod = "GET"

// CorpusAPI configures the live face (ADR 0038 §5): a generated
// `conn:<name>/get` tool that reads the CURRENT state of a resource, which
// retrieval (as of the last sync) cannot.
//
// Three limits make it safe, and only the first is expressed here — the other
// two belong to the driver, which is the only thing that can enforce them:
// a driver-declared path allowlist, and proof that the request stays inside
// spec.scope.
type CorpusAPI struct {
	// enabled turns the live face on. Default false: a Corpus that only
	// feeds a knowledge base needs no callable surface.
	// +optional
	// +kubebuilder:default=false
	Enabled bool `json:"enabled,omitempty"`

	// methods the live face may issue. v1alpha1 allows GET only — writes need
	// an authorization story this API does not yet have, and this field exists
	// so that story has somewhere to land.
	// +optional
	// +kubebuilder:default={GET}
	Methods []CorpusAPIMethod `json:"methods,omitempty"`
}

// CorpusSpec defines the desired state of Connection.
//
// A Corpus is ONE SCOPED SUBSET of an external system — this Confluence
// space, this Slack channel, this Drive folder — plus the credential that
// reaches it (ADR 0038). Several Corpora of the same provider are ordinary:
// two Slack channels are two Corpora pointing at the same Secret.
//
// Scope shape is validated at ADMISSION, but only as far as it still can be:
// which provider a Corpus belongs to now lives on its Connection, and CEL
// cannot read another resource. So the rule that does not need the provider —
// exactly one unit, never two — is enforced here, and the provider-specific
// match (confluence wants a space, slack a channel) is enforced by the
// controller, and again by the driver when it binds.
//
// Weaker than ADR 0038's admission check, and deliberately so: the alternative
// is copying `provider` onto every Corpus purely to satisfy a validator, which
// reintroduces the duplication ADR 0043 exists to remove.
// +kubebuilder:validation:XValidation:rule="[has(self.scope.space), has(self.scope.channel), has(self.scope.folderID)].filter(x, x).size() == 1",message="a Corpus must be scoped to exactly one unit: a space, a channel, or a folderID"
// +kubebuilder:validation:XValidation:rule="!has(self.sync) || self.sync.mode == 'none' || has(self.sync.reconcileInterval)",message="sync.reconcileInterval is required unless sync.mode is none: webhooks are lossy and the reconcile pass is the source of truth"
type CorpusSpec struct {
	// connectionRef names the Connection (same namespace) this Corpus draws
	// from — the authenticated route to the system, holding the provider, the
	// address and the credential (ADR 0043).
	//
	// One Connection serves many Corpora: a Slack workspace with ten indexed
	// channels is one Connection and ten Corpora, and rotating the credential
	// touches one object rather than ten.
	// +required
	// +kubebuilder:validation:MinLength=1
	ConnectionRef string `json:"connectionRef"`

	// description is fed to the orchestrator's embedder and tells the planner
	// what this corpus holds.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// displayName is what citations render (e.g. "#globex-eng"). Two Corpora of
	// the same provider inside one KnowledgeBase need distinct values, or a
	// cited answer cannot say which channel it came from. Defaults to
	// metadata.name.
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	// allowedRoles gates retrieval and invocation (RBAC filter) — a caller must
	// hold at least one. Every chunk this Corpus contributes is written with
	// these roles and filtered on them at read time, which is what lets one
	// knowledge base safely mix Corpora of differing sensitivity.
	//
	// It lives HERE rather than on the Connection or the KnowledgeBase because
	// a chunk is stamped once, at ingest (ADR 0043 §2): roles on the Connection
	// would be workspace-wide, and roles on the view would have no single value
	// to write when two knowledge bases disagree about the same channel.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// tier is an operator-defined cost/trust classification (e.g. "standard",
	// "privileged"), as on Tool.
	// +optional
	Tier string `json:"tier,omitempty"`

	// scope bounds the resources this Corpus reaches. See CorpusScope.
	// +required
	Scope CorpusScope `json:"scope"`

	// sync selects how this Corpus learns that its resources changed.
	// +optional
	Sync *CorpusSync `json:"sync,omitempty"`

	// api exposes the live, scope-enforced GET face (ADR 0038 §5).
	// +optional
	API *CorpusAPI `json:"api,omitempty"`
}

// CorpusWebhookStatus reports the provider-side subscription.
//
// expiresAt matters operationally: a Google Drive push channel lapses after
// about a week, and a silently expired channel degrades this Corpus to its
// reconcile interval — correct, but slower than anyone expects.
type CorpusWebhookStatus struct {
	// registered is true while a provider subscription is believed live.
	// +optional
	Registered bool `json:"registered,omitempty"`

	// expiresAt is when the provider will stop delivering unless renewed.
	// +optional
	ExpiresAt *metav1.Time `json:"expiresAt,omitempty"`
}

// CorpusStatus defines the observed state of Connection.
type CorpusStatus struct {
	// provider is copied from the referenced Connection by the controller.
	//
	// Published into status rather than joined across resources by every
	// consumer: both engines watch Corpora to build their catalogs, and making
	// each of them resolve a Connection would spread ADR 0043's split across
	// two engines instead of keeping it in one controller.
	// +optional
	Provider string `json:"provider,omitempty"`

	// identityProviders is copied from the referenced Connection, for the same
	// reason as provider. Empty means this Corpus can be ingested but not
	// probed, so it cannot answer for a caller whose access differs from the
	// ingestion credential's (ADR 0040).
	// +optional
	IdentityProviders []string `json:"identityProviders,omitempty"`

	// collection is the vector-store collection this Corpus owns. Storage
	// is per-Corpus rather than per-KnowledgeBase so that a Corpus
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
	Webhook *CorpusWebhookStatus `json:"webhook,omitempty"`

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
type Corpus struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of Connection
	// +required
	Spec CorpusSpec `json:"spec"`

	// status defines the observed state of Connection
	// +optional
	Status CorpusStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// CorpusList contains a list of Connection
type CorpusList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Corpus `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Corpus{}, &CorpusList{})
}
