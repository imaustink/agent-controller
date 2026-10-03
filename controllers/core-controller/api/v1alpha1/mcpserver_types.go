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

// MCPToolExposure maps ONE remote tool a Model Context Protocol server
// advertises onto the catalog, with the roles an operator assigns it (ADR 0045
// §4).
//
// Exposure is default-DENY: a remote tool becomes a callable MCPTool only
// because an operator wrote an entry for it here. What the server advertises
// about the tool (its name, description, schema) never grants it visibility or
// a role — those are the operator's to set, which is what keeps the
// materialized record trustworthy once it reaches the fail-closed retrieval
// filter (ADR 0004). A server that adds a tool tomorrow surfaces in
// status.discoveredTools and nowhere else until an entry here names it.
type MCPToolExposure struct {
	// remoteToolName is the tool's name as the server reports it in tools/list.
	// It is matched against status.discoveredTools; an entry naming a tool the
	// server does not (yet) advertise materializes nothing.
	// +required
	// +kubebuilder:validation:MinLength=1
	RemoteToolName string `json:"remoteToolName"`

	// expose materializes this tool when true. It defaults true, so listing a
	// tool exposes it; set false to keep the entry (and its role assignment) on
	// record while temporarily withdrawing the tool from the catalog.
	// +optional
	// +kubebuilder:default=true
	Expose bool `json:"expose,omitempty"`

	// allowedRoles are the roles the materialized MCPTool carries — the RBAC
	// retrieval filter (ADR 0004, fail-closed). Assigned by the operator, never
	// derived from the server.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// toolID overrides the catalog id of the materialized MCPTool. Defaults to a
	// deterministic id derived from the server and remote tool name; set it to
	// avoid a collision or to give the tool a stable, friendlier id.
	//
	// It becomes the MCPTool's metadata.name verbatim, so it must be a valid
	// Kubernetes object name (a DNS-1123 subdomain) — the broker uses it as-is
	// rather than sanitizing, because a silent rename would break the id a Skill
	// references in toolRefs. Validated here so the apiserver rejects a bad value
	// (e.g. underscores or capitals) at write time instead of the broker failing
	// to materialize the tool with only a log line.
	// +optional
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$`
	ToolID string `json:"toolID,omitempty"`

	// hidden materializes the tool as referenceable-by-id but never returned by
	// semantic retrieval (ADR 0008) — for a tool a Skill scopes rather than one
	// agents discover openly.
	// +optional
	Hidden bool `json:"hidden,omitempty"`

	// tier is an operator-defined cost/trust classification carried onto the
	// materialized MCPTool (e.g. "standard", "privileged").
	// +optional
	Tier string `json:"tier,omitempty"`
}

// MCPServerSpec is an authenticated route to one Model Context Protocol server
// (ADR 0045). It is operator-authored and privileged: creating one introduces
// an externally-controlled call path reachable by agents, so gate CR
// create/update via k8s RBAC.
//
// The mcp-broker — the only component that speaks MCP — discovers this server's
// tools into status.discoveredTools and materializes each EXPOSED one as a
// derived MCPTool. The agent loop never sees MCP; it calls an ordinary catalog
// tool whose dispatch happens to proxy through the broker.
type MCPServerSpec struct {
	// transport selects how the broker reaches the server.
	//
	// Only streamable-http is supported today: it is stateless per call, which
	// lets invocation carry the CALLER's delegated token on each tools/call
	// without a shared session (ADR 0045 §5). stdio and session-bound sse are
	// deferred to a second auth mode; adding them is an enum widening here, not
	// a new CRD.
	// +required
	// +kubebuilder:validation:Enum=streamable-http
	Transport string `json:"transport"`

	// url is the server's endpoint. API calls go here; it is the broker's address
	// for the server, not a human-facing one.
	//
	// https:// for an external server, so the delegated token is encrypted in
	// transit; http:// is permitted for a cluster-internal MCP server (a
	// Service), where the token stays on the cluster network. A scheme is
	// required either way.
	// +required
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Pattern=`^https?://`
	URL string `json:"url"`

	// displayName names the server for operators (e.g. "GitHub MCP").
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	// secretEnv are environment variables sourced from Secret keys in the same
	// namespace (never literal values), resolved by the mcp-broker.
	//
	// This is the DISCOVERY credential — a shared service identity the broker
	// uses for tools/list. It is deliberately separate from invocation, which
	// runs as the calling user (see identityProviders). A server that needs no
	// credential to list its tools leaves this empty.
	// +optional
	SecretEnv []SecretEnvVar `json:"secretEnv,omitempty"`

	// identityProviders names the IdentityProvider CRs whose per-user delegated
	// credential the broker presents on tools/call (ADR 0032's mechanism).
	//
	// This is the INVOCATION credential, resolved per call so a proxied tool
	// runs as the user who asked, never as a shared subject. If resolution fails
	// or the token has expired the call fails closed — it never falls back to
	// the discovery credential (ADR 0045 §5). Empty means the server needs no
	// per-user identity to call its tools.
	// +optional
	IdentityProviders []string `json:"identityProviders,omitempty"`

	// exposure is the default-deny map of which advertised tools become callable
	// MCPTools, and with which roles. Empty exposes nothing, however many tools
	// the server advertises. See MCPToolExposure.
	// +optional
	// +listType=map
	// +listMapKey=remoteToolName
	Exposure []MCPToolExposure `json:"exposure,omitempty"`
}

// MCPDiscoveredTool is one tool the server advertised on the last successful
// tools/list. It is a REPORT, not a grant: a tool appearing here is callable
// only once an MCPToolExposure entry names it (ADR 0045 §4).
type MCPDiscoveredTool struct {
	// name is the tool's name as the server reports it.
	// +required
	Name string `json:"name"`

	// description is the server's own description of the tool.
	// +optional
	Description string `json:"description,omitempty"`

	// inputSchema is the tool's JSON Schema as advertised, carried verbatim so an
	// operator can see what an exposed tool would accept.
	// +optional
	InputSchema string `json:"inputSchema,omitempty"`

	// exposed reports whether an MCPToolExposure entry currently materializes
	// this tool, so `kubectl get` on the server shows at a glance what is live.
	// +optional
	Exposed bool `json:"exposed,omitempty"`
}

// MCPServerStatus defines the observed state of MCPServer.
type MCPServerStatus struct {
	// discoveredTools is the full inventory from the last successful tools/list.
	// It only surfaces what the server offers; it grants nothing.
	// +optional
	// +listType=map
	// +listMapKey=name
	DiscoveredTools []MCPDiscoveredTool `json:"discoveredTools,omitempty"`

	// exposedTools is how many MCPTools this server currently materializes — the
	// count of exposure entries that matched a discovered tool.
	// +optional
	ExposedTools int64 `json:"exposedTools,omitempty"`

	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// conditions follow the usual Ready/Degraded convention. Ready reports a
	// successful discovery; Degraded reports a server the broker could not reach
	// or list.
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Transport",type=string,JSONPath=`.spec.transport`
// +kubebuilder:printcolumn:name="URL",type=string,JSONPath=`.spec.url`
// +kubebuilder:printcolumn:name="Exposed",type=integer,JSONPath=`.status.exposedTools`

// MCPServer is an authenticated route to one Model Context Protocol server
// (ADR 0045).
type MCPServer struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// +required
	Spec MCPServerSpec `json:"spec"`

	// +optional
	Status MCPServerStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// MCPServerList contains a list of MCPServer.
type MCPServerList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []MCPServer `json:"items"`
}

func init() {
	SchemeBuilder.Register(&MCPServer{}, &MCPServerList{})
}
