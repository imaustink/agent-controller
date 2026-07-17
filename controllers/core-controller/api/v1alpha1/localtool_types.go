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

// LocalToolSpec defines the desired state of LocalTool (ADR 0014). Unlike a
// Tool (which points at a prebuilt container image the core-controller runs as
// a k8s Job), a LocalTool points at PACKAGED CODE pulled from a language
// registry at runtime and executed by a per-language executor SIDECAR in the
// orchestrator pod. It is never launched as a Job and never touched by this
// controller's Job builder — this controller only validates the spec and sets
// a Ready condition; the orchestrator reads LocalTool CRs directly.
//
// SECURITY: creating a LocalTool is a privileged operation — it causes
// arbitrary third-party code to be fetched and executed inside the
// orchestrator pod. Gate CR create/update via k8s RBAC accordingly.
type LocalToolSpec struct {
	// description is fed to the orchestrator's embedder for RAG tool retrieval.
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// input describes the stdin contract for the tool (the ABI is: JSON/string
	// on stdin -> one final JSON envelope on stdout; exit 0 = success).
	// +required
	Input string `json:"input"`

	// output describes the tool's result envelope shape.
	// +required
	Output string `json:"output"`

	// allowedRoles gates RAG retrieval (RBAC filter) — caller must have at least
	// one of these roles for this LocalTool to be a candidate.
	// +required
	// +kubebuilder:validation:MinItems=1
	AllowedRoles []string `json:"allowedRoles"`

	// tier is an operator-defined cost/trust classification (e.g. "standard", "privileged").
	// +optional
	Tier string `json:"tier,omitempty"`

	// runtime selects which executor sidecar runs this tool. Each runtime
	// resolves `package`/`version` (or `sourceURL`/`checksum` for shell)
	// against its own registry and toolchain.
	// +required
	// +kubebuilder:validation:Enum=node;python;go;shell
	Runtime string `json:"runtime"`

	// package is the registry package coordinate the sidecar fetches — an npm
	// package name (node), a PyPI distribution (python), or a Go module path
	// including the command, e.g. example.com/x/cmd/tool (go). Required for
	// node/python/go; ignored for shell (which uses sourceURL).
	// +optional
	Package string `json:"package,omitempty"`

	// version is the EXACT pinned version to fetch (no ranges/tags like
	// "latest" or "^1.2.0"). Required for node/python/go; the sidecar rejects
	// unpinned versions fail-closed. Ignored for shell.
	// +optional
	Version string `json:"version,omitempty"`

	// entry is the module/console-script/binary the sidecar invokes within the
	// fetched package when it differs from the package's default. Optional.
	// +optional
	Entry string `json:"entry,omitempty"`

	// sourceURL is the pinned https:// location of the script to run. Required
	// for the shell runtime (which has no package registry); ignored otherwise.
	// +optional
	SourceURL string `json:"sourceURL,omitempty"`

	// checksum is the lowercase hex sha256 digest of the fetched artifact,
	// verified by the sidecar before execution. REQUIRED for shell (integrity
	// of an arbitrary URL); recommended for the other runtimes.
	// +optional
	Checksum string `json:"checksum,omitempty"`

	// env are static, non-secret environment variables passed to the tool.
	// +optional
	Env []EnvVar `json:"env,omitempty"`

	// secretEnv are environment variables sourced from Secret keys in the same
	// namespace (never literal values). The ORCHESTRATOR resolves these (it
	// holds the k8s identity; the sidecars deliberately do not) and passes the
	// resolved values to the sidecar over the pod-local unix socket.
	// +optional
	SecretEnv []SecretEnvVar `json:"secretEnv,omitempty"`

	// network opts this tool into egress. Default false: the sidecar runs the
	// tool with its network namespace unshared (no network). Set true only for
	// tools that must reach out (e.g. an HTTP fetcher) — those tools remain
	// responsible for their own SSRF defenses.
	// +optional
	Network bool `json:"network,omitempty"`

	// timeoutSeconds bounds a single execution; the sidecar SIGKILLs past it.
	// Falls back to the orchestrator/sidecar default (30s) when unset.
	// +optional
	// +kubebuilder:validation:Minimum=1
	TimeoutSeconds int32 `json:"timeoutSeconds,omitempty"`

	// resources are the per-execution resource bounds (mapped to rlimits by the
	// sidecar), mirroring the cpu/memory subset used elsewhere.
	// +optional
	Resources ResourceRequirements `json:"resources,omitempty"`
}

// LocalToolStatus defines the observed state of LocalTool.
type LocalToolStatus struct {
	// conditions represent the current state of the LocalTool resource.
	// Standard condition types include "Available"/"Progressing"/"Degraded";
	// this controller uses "Ready" to report spec validity.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status

// LocalTool is the Schema for the localtools API
type LocalTool struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of LocalTool
	// +required
	Spec LocalToolSpec `json:"spec"`

	// status defines the observed state of LocalTool
	// +optional
	Status LocalToolStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// LocalToolList contains a list of LocalTool
type LocalToolList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []LocalTool `json:"items"`
}

func init() {
	SchemeBuilder.Register(&LocalTool{}, &LocalToolList{})
}
