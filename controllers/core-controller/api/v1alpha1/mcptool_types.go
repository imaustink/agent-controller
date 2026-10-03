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

// MCPToolSpec is the materialized form of one exposed Model Context Protocol
// tool (ADR 0045). It is the catalog record a remote MCP tool becomes: an
// ordinary tool whose dispatch kind is `mcpExec`, carrying enough to let the
// mcp-broker proxy one tools/call.
//
// DERIVED, DO NOT EDIT: the mcp-broker writes MCPTool objects from an
// MCPServer's exposure map (ADR 0045 §1) and owns them via an ownerReference,
// so deleting the server cascades its tools. Hand-editing one is pointless — the
// broker reconciles it back. Operators change what is exposed on the MCPServer,
// not here.
type MCPToolSpec struct {
	// serverRef is the name of the MCPServer this tool is proxied through, in
	// the same namespace. The broker opens no session of its own per tool; it
	// routes a call to this server under the caller's identity.
	// +required
	// +kubebuilder:validation:MinLength=1
	ServerRef string `json:"serverRef"`

	// remoteToolName is the tool's name on the server, the argument to
	// tools/call. It need not equal the catalog id (see the owning server's
	// exposure toolID).
	// +required
	// +kubebuilder:validation:MinLength=1
	RemoteToolName string `json:"remoteToolName"`

	// description is fed to the orchestrator's embedder for RAG tool retrieval —
	// the server's own description of the tool. An MCPTool competes in retrieval
	// and delegate selection exactly like any other tool.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// inputSchema is the remote tool's JSON Schema, carried verbatim from
	// discovery. The broker uses it to validate arguments before proxying and
	// the engine uses it to render the tool's input contract to the planner.
	// +optional
	InputSchema string `json:"inputSchema,omitempty"`

	// allowedRoles gates RAG retrieval (RBAC filter, ADR 0004, fail-closed) —
	// the caller must hold at least one. Copied from the owning server's
	// exposure entry; assigned by the operator, never by the server.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// hidden makes the tool referenceable-by-id but never returned by semantic
	// retrieval (ADR 0008). Copied from the exposure entry.
	// +optional
	Hidden bool `json:"hidden,omitempty"`

	// tier is an operator-defined cost/trust classification. Copied from the
	// exposure entry.
	// +optional
	Tier string `json:"tier,omitempty"`

	// identityProviders names the IdentityProvider CRs whose per-user delegated
	// credential the broker presents on tools/call. Copied from the owning
	// server so the dispatch path need not join back across resources; an
	// expired or unresolvable token fails the call closed (ADR 0045 §5).
	// +optional
	IdentityProviders []string `json:"identityProviders,omitempty"`
}

// MCPToolStatus defines the observed state of MCPTool.
type MCPToolStatus struct {
	// conditions follow the usual Ready convention. Ready means the owning
	// server still advertises this remote tool; the broker drops a tool the
	// server stops offering rather than leaving it to fail only when invoked
	// (ADR 0045 §6 — the live server is truth for existence).
	// +optional
	// +listType=map
	// +listMapKey=type
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Server",type=string,JSONPath=`.spec.serverRef`
// +kubebuilder:printcolumn:name="RemoteTool",type=string,JSONPath=`.spec.remoteToolName`

// MCPTool is a catalog tool proxied to a Model Context Protocol server
// (ADR 0045). It is written and owned by the mcp-broker, not by operators.
type MCPTool struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// +required
	Spec MCPToolSpec `json:"spec"`

	// +optional
	Status MCPToolStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// MCPToolList contains a list of MCPTool.
type MCPToolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []MCPTool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&MCPTool{}, &MCPToolList{})
}
