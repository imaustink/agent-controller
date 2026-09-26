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

// ConnectionSite locates the tenant a Connection reads from.
//
// Only some providers have one. Confluence does — its API is addressed by a
// per-site `cloudId` that is not derivable from the URL a human uses — while a
// Slack channel or a Drive folder is reached without any site-level
// coordinates.
type ConnectionSite struct {
	// baseURL is the site as a HUMAN visits it, including any context path
	// (Confluence lives under /wiki even on a custom domain).
	//
	// This builds CITATIONS, and nothing else. It is deliberately not where API
	// calls go: an Atlassian OAuth token is rejected by the site host and
	// accepted only at the gateway, so the two are different addresses for the
	// same tenant. Getting this wrong yields citations nobody can open, which
	// for a knowledge base is close to having no citations.
	// +required
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Pattern=`^https://`
	BaseURL string `json:"baseURL"`

	// cloudId names the Atlassian site directly.
	//
	// REQUIRED for a site on a custom domain, and the driver refuses to run
	// without it. Discovery works by matching baseURL against the addresses the
	// token reports, and a custom domain never appears there — those are always
	// the canonical *.atlassian.net form. The tempting fallback of "only one
	// site is reachable, so use it" is unsafe: nothing has confirmed that site
	// is this tenant, and a credential issued for another org satisfies it
	// exactly, pointing the whole Connection at someone else's content.
	//
	// Read it from `node apps/connection-broker/scripts/verify-confluence.mjs`.
	// +optional
	CloudID string `json:"cloudId,omitempty"`
}

// ConnectionAllowedScopes caps which subsets a Connection's Corpora may reach.
//
// Optional. Present, it is an allowlist and a Corpus outside it is rejected;
// absent, any subset the credential can reach is permitted.
//
// It exists so the credential holder decides what the credential may pull
// (ADR 0043 §3). Without it, anyone who can create a Corpus can reach anything
// the token can, and the broker would be taking the caller's word for what is
// in scope — which is the dependency the driver's own scope check exists to
// avoid.
type ConnectionAllowedScopes struct {
	// spaces are Confluence space keys.
	// +optional
	Spaces []string `json:"spaces,omitempty"`

	// channels are Slack channel ids.
	// +optional
	Channels []string `json:"channels,omitempty"`

	// folderIDs are Google Drive folder ids.
	// +optional
	FolderIDs []string `json:"folderIDs,omitempty"`
}

// ConnectionSpec is an authenticated route to one external system (ADR 0043).
//
// One per Slack workspace, Confluence site or Drive account — NOT one per
// channel or space. What to index from it is a Corpus, and many Corpora share
// one Connection, so rotating a credential is one edit rather than ten.
// +kubebuilder:validation:XValidation:rule="self.provider != 'confluence' || has(self.site)",message="a confluence Connection must set site.baseURL; citations cannot be built without it"
// +kubebuilder:validation:XValidation:rule="!has(self.autoJoin) || !self.autoJoin || self.provider == 'slack'",message="autoJoin is only meaningful for a slack Connection"
type ConnectionSpec struct {
	// provider selects the driver that knows how to list, fetch, watch and
	// call this system. Adding a provider is an implementation of the driver
	// interface, not a new CRD.
	// +required
	// +kubebuilder:validation:Enum=confluence;slack;gdrive
	Provider string `json:"provider"`

	// displayName names the system for operators (e.g. "Bitovi Slack").
	// Citations render a Corpus's displayName, not this one.
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	// site locates the tenant, for providers that have one. Required for
	// confluence. See ConnectionSite.
	// +optional
	Site *ConnectionSite `json:"site,omitempty"`

	// allowedScopes caps which subsets this Connection's Corpora may reach.
	// See ConnectionAllowedScopes.
	// +optional
	AllowedScopes *ConnectionAllowedScopes `json:"allowedScopes,omitempty"`

	// autoJoin lets the ingestion credential add itself to a scoped Slack
	// channel when a read is refused for want of membership.
	//
	// Off by default, because joining is a WRITE: it changes workspace state
	// and posts a visible "joined the channel" event. Turning it on also
	// requires the `channels:join` scope on the bot token, which is the one
	// scope here that is not read-only.
	//
	// It lives on the Connection rather than the Corpus because it is a
	// property of the credential — what that token is permitted to do — not of
	// any one channel. It never applies to a retrieval probe: joining on a
	// caller's behalf would change the answer rather than report it.
	// +optional
	AutoJoin bool `json:"autoJoin,omitempty"`

	// secretEnv are environment variables sourced from Secret keys in the same
	// namespace (never literal values), resolved by the connection-broker.
	//
	// This is the INGESTION credential, and it stays a shared service one: a
	// scheduled reconcile has no calling user, so a per-user sync is incoherent
	// as stated (ADR 0038 §7). Retrieval is the opposite — see
	// identityProviders.
	// +optional
	SecretEnv []SecretEnvVar `json:"secretEnv,omitempty"`

	// identityProviders names the IdentityProvider CRs whose per-user delegated
	// credential this system needs for RETRIEVAL (ADR 0032's mechanism,
	// required by ADR 0040).
	//
	// On the Connection rather than the Corpus because it describes how a HUMAN
	// authenticates to the system, which cannot differ between two channels of
	// one workspace. The controller copies it into each Corpus's status so
	// consumers need not join across resources.
	// +optional
	IdentityProviders []string `json:"identityProviders,omitempty"`
}

// ConnectionStatus defines the observed state of Connection.
type ConnectionStatus struct {
	// corpora is how many Corpora currently reference this Connection.
	//
	// Published because it is what makes deletion refusable: removing a
	// credential should not destroy indexed material as a side effect
	// (ADR 0043 §4).
	// +optional
	Corpora int64 `json:"corpora,omitempty"`

	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// conditions follow the usual Ready/Degraded convention.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Provider",type=string,JSONPath=`.spec.provider`
// +kubebuilder:printcolumn:name="Corpora",type=integer,JSONPath=`.status.corpora`

// Connection is an authenticated route to one external system (ADR 0043).
type Connection struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// +required
	Spec ConnectionSpec `json:"spec"`

	// +optional
	Status ConnectionStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// ConnectionList contains a list of Connection.
type ConnectionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []Connection `json:"items"`
}

func init() {
	SchemeBuilder.Register(&Connection{}, &ConnectionList{})
}
