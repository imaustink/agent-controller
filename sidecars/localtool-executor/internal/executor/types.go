// Package executor implements a per-language LocalTool executor sidecar
// (ADR 0014). One process per runtime (node|python|go|shell) listens on a
// pod-local unix socket, fetches a pinned package from its language registry
// (caching it), and runs it under a per-invocation bubblewrap sandbox
// (unshared network unless opted in, read-only fs, cleared env, rlimits,
// timeout). The stdio ABI is: the caller's input arrives on the tool's stdin,
// and the tool writes exactly one final JSON envelope to stdout.
//
// SECURITY: this sidecar deliberately has NO Kubernetes identity (the pod
// sets automountServiceAccountToken:false and mounts the SA token only into
// the orchestrator container). Secret values are resolved by the orchestrator
// and arrive already-resolved in the run request over the unix socket.
package executor

import "encoding/json"

// RunRequest is the POST /run body — mirrors the orchestrator's
// LocalToolRunRequest (apps/agent-orchestrator/src/local/local-tool-executor.ts).
type RunRequest struct {
	Runtime        string            `json:"runtime"`
	Package        string            `json:"package,omitempty"`
	Version        string            `json:"version,omitempty"`
	Entry          string            `json:"entry,omitempty"`
	SourceURL      string            `json:"sourceUrl,omitempty"`
	Checksum       string            `json:"checksum,omitempty"`
	Env            map[string]string `json:"env,omitempty"`
	Input          string            `json:"input"`
	Network        bool              `json:"network,omitempty"`
	TimeoutSeconds int               `json:"timeoutSeconds,omitempty"`
	Resources      *Resources        `json:"resources,omitempty"`
}

// Resources is the cpu/memory subset the orchestrator may pass; mapped to
// rlimits by the sandbox where possible.
type Resources struct {
	Requests map[string]string `json:"requests,omitempty"`
	Limits   map[string]string `json:"limits,omitempty"`
}

// Envelope is the stdio-ABI result the sidecar relays back — the tool's final
// stdout line, or a sidecar-generated failure.
type Envelope struct {
	Type    string          `json:"type"`              // "succeeded" | "failed"
	Result  json.RawMessage `json:"result,omitempty"`  // succeeded
	Code    string          `json:"code,omitempty"`    // failed
	Message string          `json:"message,omitempty"` // failed
}

// succeeded/failed are envelope constructors kept terse for readability.
func failedEnvelope(code, message string) Envelope {
	return Envelope{Type: "failed", Code: code, Message: message}
}
