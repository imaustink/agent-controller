// Package localtool is the Go port of agent-orchestrator's
// src/local/local-tool-executor.ts (ADR 0014): the client side of a
// LocalTool's dispatch to a per-language executor sidecar running in the same
// pod. The engine never fetches, sandboxes, or runs a LocalTool's code
// itself — that is entirely the sidecar's job — it only resolves secretEnv
// from k8s Secrets (the engine holds the k8s identity; the sidecars
// deliberately do not) and relays one HTTP request over a pod-local unix
// socket, mapping the sidecar's stdio-ABI envelope onto a messaging.Event so
// the rest of the dispatch path treats a local run exactly like a Job
// callback result.
package localtool

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"path/filepath"
	"time"

	"github.com/google/uuid"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/messaging"
)

// RunRequest is what the engine POSTs to a sidecar's `<socketDir>/<runtime>.sock`
// over `/run`. Mirrors the Go executor's expected body (sidecars/localtool-executor).
// Secret values are already RESOLVED here — they travel only over the
// pod-local unix socket, never the network.
type RunRequest struct {
	Runtime        string            `json:"runtime"`
	Package        string            `json:"package,omitempty"`
	Version        string            `json:"version,omitempty"`
	Entry          string            `json:"entry,omitempty"`
	SourceURL      string            `json:"sourceUrl,omitempty"`
	Checksum       string            `json:"checksum,omitempty"`
	Env            map[string]string `json:"env"`
	Input          string            `json:"input"`
	Network        bool              `json:"network"`
	TimeoutSeconds int32             `json:"timeoutSeconds"`
}

// Envelope is the stdio-ABI result a tool process prints as its one final
// stdout line, relayed back verbatim by the sidecar.
type Envelope struct {
	Type    string          `json:"type"` // succeeded | failed
	Result  json.RawMessage `json:"result,omitempty"`
	Code    string          `json:"code,omitempty"`
	Message string          `json:"message,omitempty"`
}

// SecretReader reads a Secret key's plaintext value; abstracted so tests can
// fake it without a real cluster.
type SecretReader interface {
	Read(ctx context.Context, secretName, key string) (string, bool, error)
}

var secretGVR = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}

// K8sSecretReader is the default SecretReader, backed by the dynamic client
// every other k8s-touching piece of this engine already uses (see
// internal/authz.K8sSecretWriter).
type K8sSecretReader struct {
	Client    dynamic.Interface
	Namespace string
}

func (r *K8sSecretReader) Read(ctx context.Context, secretName, key string) (string, bool, error) {
	obj, err := r.Client.Resource(secretGVR).Namespace(r.Namespace).Get(ctx, secretName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return "", false, nil
		}
		return "", false, err
	}
	encoded, found, err := unstructured.NestedString(obj.Object, "data", key)
	if err != nil || !found {
		return "", false, nil
	}
	decoded, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", false, fmt.Errorf("decode secret %s/%s: %w", secretName, key, err)
	}
	return string(decoded), true, nil
}

// Options configures an Executor.
type Options struct {
	// SocketDir holds one `<runtime>.sock` per executor sidecar.
	SocketDir string
	// DefaultTimeoutSeconds is the fallback per-execution timeout when a
	// LocalTool sets none.
	DefaultTimeoutSeconds int32
	// SecretReader resolves secretEnv references into plaintext values.
	SecretReader SecretReader
	// BackstopBufferSeconds is extra time added to a tool's timeout before
	// this client gives up on an unresponsive sidecar (the sidecar's own
	// SIGKILL should normally win). Defaults to 5.
	BackstopBufferSeconds float64
}

// Executor is the client for the per-language executor sidecars (ADR 0014).
type Executor struct {
	opts Options
}

func NewExecutor(opts Options) *Executor {
	return &Executor{opts: opts}
}

// Run resolves the tool's secretEnv, POSTs a run request to the matching
// sidecar over its unix socket, and maps the returned envelope onto a
// messaging.Event. Every failure mode (bad spec, missing secret, transport
// error, non-2xx, malformed body, timeout) becomes a "failed" Event rather
// than a Go error — a local run's outcome is a result to reason about, same
// discipline as a Job callback.
//
// sessionId, if given, is set as SESSION_ID in the tool process's own env
// (upstream ADR 0012) — a LocalTool runs in-pod rather than as a separate
// Job, so there is no k8s annotation to attach it to; this is how its own
// logs can still be correlated back to the caller's session.
func (e *Executor) Run(ctx context.Context, tool catalog.ToolDescriptor, input, sessionID string) messaging.Event {
	jobID := newJobID()
	spec := tool.LocalExec
	if spec == nil {
		return failed(jobID, "not_local", fmt.Sprintf("tool %s has no localExec spec", tool.ID))
	}

	env := make(map[string]string, len(spec.Env)+1)
	for k, v := range spec.Env {
		env[k] = v
	}
	if sessionID != "" {
		env["SESSION_ID"] = sessionID
	}
	for _, ref := range spec.SecretEnv {
		value, found, err := e.opts.SecretReader.Read(ctx, ref.SecretName, ref.SecretKey)
		if err != nil {
			return failed(jobID, "secret_error", fmt.Sprintf("failed to read secret %s: %s", ref.SecretName, err))
		}
		if !found {
			return failed(jobID, "secret_missing", fmt.Sprintf("secret %s/%s not found", ref.SecretName, ref.SecretKey))
		}
		env[ref.Name] = value
	}

	timeoutSeconds := spec.TimeoutSeconds
	if timeoutSeconds <= 0 {
		timeoutSeconds = e.opts.DefaultTimeoutSeconds
	}
	req := RunRequest{
		Runtime:        spec.Runtime,
		Package:        spec.Package,
		Version:        spec.Version,
		Entry:          spec.Entry,
		SourceURL:      spec.SourceURL,
		Checksum:       spec.Checksum,
		Env:            env,
		Input:          input,
		Network:        spec.Network,
		TimeoutSeconds: timeoutSeconds,
	}

	bufferSeconds := e.opts.BackstopBufferSeconds
	if bufferSeconds <= 0 {
		bufferSeconds = 5
	}
	backstop := time.Duration(float64(timeoutSeconds)*float64(time.Second) + bufferSeconds*float64(time.Second))
	socketPath := filepath.Join(e.opts.SocketDir, spec.Runtime+".sock")

	envelope, err := postToSidecar(ctx, socketPath, req, backstop)
	if err != nil {
		return failed(jobID, "executor_error", fmt.Sprintf("local tool %s: %s", tool.ID, err))
	}
	return toEvent(jobID, envelope)
}

func newJobID() string {
	return "local-" + uuid.NewString()
}

func nowRFC3339() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func postToSidecar(ctx context.Context, socketPath string, req RunRequest, timeout time.Duration) (Envelope, error) {
	body, err := json.Marshal(req)
	if err != nil {
		return Envelope{}, err
	}

	client := &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socketPath)
			},
		},
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://localtool/run", bytes.NewReader(body))
	if err != nil {
		return Envelope{}, err
	}
	httpReq.Header.Set("content-type", "application/json")

	resp, err := client.Do(httpReq)
	if err != nil {
		return Envelope{}, err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Envelope{}, err
	}
	if resp.StatusCode >= 300 {
		text := string(respBody)
		if len(text) > 500 {
			text = text[:500]
		}
		return Envelope{}, fmt.Errorf("sidecar returned %d: %s", resp.StatusCode, text)
	}

	var envelope Envelope
	if err := json.Unmarshal(respBody, &envelope); err != nil {
		text := string(respBody)
		if len(text) > 200 {
			text = text[:200]
		}
		return Envelope{}, fmt.Errorf("sidecar returned non-JSON body: %s", text)
	}
	return envelope, nil
}

func toEvent(jobID string, envelope Envelope) messaging.Event {
	switch envelope.Type {
	case messaging.EventSucceeded:
		return messaging.Event{Type: messaging.EventSucceeded, Result: envelope.Result, JobID: jobID, TS: nowRFC3339()}
	case messaging.EventFailed:
		code := envelope.Code
		if code == "" {
			code = "failed"
		}
		message := envelope.Message
		if message == "" {
			message = "tool failed"
		}
		return failed(jobID, code, message)
	default:
		return failed(jobID, "bad_envelope", "sidecar returned an unrecognized envelope")
	}
}

func failed(jobID, code, message string) messaging.Event {
	return messaging.Event{Type: messaging.EventFailed, Code: code, Message: message, JobID: jobID, TS: nowRFC3339()}
}
