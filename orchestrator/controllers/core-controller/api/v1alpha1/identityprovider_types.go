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

// IdentityProviderFlow names which link mechanism a provider's credential is
// obtained through — i.e. which of agent-orchestrator's fixed IdentityLinkPort
// implementations backs it (docs/adr/0027). This is a closed set on purpose:
// unlike envVar/label/crossEntryPoint below, a flow is a concrete gateway
// implementation, not data an operator can invent by writing a CR — adding a
// FOURTH flow still requires new agent-orchestrator (and, for anything beyond
// "oauth", integration-gateway) code.
// +kubebuilder:validation:Enum=oauth;claude-cli-setup-token;claude-remote-login
type IdentityProviderFlow string

const (
	// IdentityProviderFlowOAuth is the default, generic OAuth device/authcode
	// flow served by integration-gateway's `/identity-link/:provider/*` API
	// (the same mechanism "github" already used, and what a new per-user
	// OAuth-delegating provider like "glyph" needs).
	IdentityProviderFlowOAuth IdentityProviderFlow = "oauth"
	// IdentityProviderFlowClaudeCLISetupToken is "claude"'s bespoke flow: a
	// PTY-driven `claude setup-token` session (docs/adr/0027).
	IdentityProviderFlowClaudeCLISetupToken IdentityProviderFlow = "claude-cli-setup-token"
	// IdentityProviderFlowClaudeRemoteLogin is "claude-remote"'s bespoke flow:
	// a full `~/.claude/.credentials.json` login (docs/adr/0027).
	IdentityProviderFlowClaudeRemoteLogin IdentityProviderFlow = "claude-remote-login"
)

// IdentityProviderSpec defines the desired state of IdentityProvider.
//
// A Tool/Agent's `identityProviders` field only ever names a provider by this
// CR's name (e.g. "github") — everything agent-orchestrator needs to actually
// resolve and inject that provider's credential lives here instead, so it is
// declared ONCE per provider and shared by every Tool/Agent that references
// it, rather than repeated (and liable to drift) on each one.
//
// Before this CRD existed, this same information was a hardcoded TypeScript
// map in agent-orchestrator (authorization-service.ts's `IDENTITY_PROVIDERS`)
// — adding a provider meant an agent-orchestrator source change and a
// redeploy of that image. Now it is cluster config: agent-orchestrator watches
// IdentityProvider CRs the same way it already watches Tool/Agent/Skill, and a
// new OAuth-based provider (flow: oauth) needs no agent-orchestrator code
// change at all, just a new CR.
type IdentityProviderSpec struct {
	// envVar is the name of the environment variable this provider's resolved
	// token is injected as on a launched AgentRun/ToolRun (AgentLaunchOptions'
	// secretEnv / ToolRunSpec.SecretEnv).
	// +required
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Pattern=`^[A-Z][A-Z0-9_]*$`
	EnvVar string `json:"envVar"`

	// label is the human-facing name used in link prompts/messages (e.g.
	// "please link your GitHub account"). Distinct providers MUST use
	// distinct labels — two providers sharing a label make their link
	// prompts indistinguishable to the person completing them (docs/adr/0027
	// learned this the hard way for "claude" vs "claude-remote").
	// +required
	// +kubebuilder:validation:MinLength=1
	Label string `json:"label"`

	// flow selects which of agent-orchestrator's fixed link-flow
	// implementations backs this provider (docs/adr/0027). Defaults to
	// "oauth", the generic device/authcode flow — set only for the two
	// Claude-specific mechanisms.
	// +optional
	// +kubebuilder:default=oauth
	Flow IdentityProviderFlow `json:"flow,omitempty"`

	// crossEntryPoint marks a provider whose credential is keyed by PRINCIPAL
	// rather than by the caller's raw entry-point subject — i.e. one a human
	// re-authorizes by hand and expects to only do once, shared across chat
	// and webhook entry points (docs/adr/0030 §6). Unset (false) keeps a
	// provider's credential scoped to the entry point that obtained it,
	// which is correct for anything establishing or reading the principal
	// itself (e.g. "github").
	// +optional
	CrossEntryPoint bool `json:"crossEntryPoint,omitempty"`
}

// IdentityProviderStatus defines the observed state of IdentityProvider.
type IdentityProviderStatus struct {
	// INSERT ADDITIONAL STATUS FIELD - define observed state of cluster
	// Important: Run "make" to regenerate code after modifying this file

	// For Kubernetes API conventions, see:
	// https://github.com/kubernetes/community/blob/master/contributors/devel/sig-architecture/api-conventions.md#typical-status-properties

	// conditions represent the current state of the IdentityProvider resource.
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
// +kubebuilder:printcolumn:name="EnvVar",type=string,JSONPath=`.spec.envVar`
// +kubebuilder:printcolumn:name="Flow",type=string,JSONPath=`.spec.flow`

// IdentityProvider is the Schema for the identityproviders API
type IdentityProvider struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of IdentityProvider
	// +required
	Spec IdentityProviderSpec `json:"spec"`

	// status defines the observed state of IdentityProvider
	// +optional
	Status IdentityProviderStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// IdentityProviderList contains a list of IdentityProvider
type IdentityProviderList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []IdentityProvider `json:"items"`
}

func init() {
	SchemeBuilder.Register(&IdentityProvider{}, &IdentityProviderList{})
}
