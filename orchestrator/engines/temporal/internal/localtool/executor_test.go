package localtool_test

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/localtool"
	"github.com/controller-agent/temporal-engine/internal/messaging"
)

// fakeSecretReader is a static map, mirroring the TS tests' SecretReader fake.
type fakeSecretReader map[string]string

func (f fakeSecretReader) Read(_ context.Context, secretName, key string) (string, bool, error) {
	v, ok := f[secretName+"/"+key]
	return v, ok, nil
}

// fakeSidecar is an HTTP server listening on a unix socket, recording the
// last request body and replying with a canned status/body — the Go
// counterpart of local-tool-executor.test.ts's startSidecar.
type fakeSidecar struct {
	socketDir   string
	lastRequest *localtool.RunRequest
	listener    net.Listener
	server      *http.Server
}

func startSidecar(t *testing.T, runtime string, handler func(req localtool.RunRequest) (status int, body string, hang bool)) *fakeSidecar {
	t.Helper()
	// A short, non-nested temp dir: t.TempDir() embeds the test name, which
	// overruns the ~104-byte unix socket path limit once joined with
	// "<runtime>.sock".
	dir, err := os.MkdirTemp("", "lt")
	require.NoError(t, err)
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	fs := &fakeSidecar{socketDir: dir}

	listener, err := net.Listen("unix", filepath.Join(dir, runtime+".sock"))
	require.NoError(t, err)
	fs.listener = listener

	mux := http.NewServeMux()
	mux.HandleFunc("/run", func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		var req localtool.RunRequest
		require.NoError(t, json.Unmarshal(body, &req))
		fs.lastRequest = &req

		status, respBody, hang := handler(req)
		if hang {
			select {} // never respond; the client's own timeout must trip
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write([]byte(respBody))
	})
	srv := &http.Server{Handler: mux}
	fs.server = srv
	go srv.Serve(listener)
	t.Cleanup(func() {
		_ = srv.Close()
		_ = os.RemoveAll(dir)
	})
	return fs
}

func localTool(overrides func(*catalog.LocalExecSpec)) catalog.ToolDescriptor {
	spec := &catalog.LocalExecSpec{Runtime: "node", Package: "p", Version: "1.0.0", Network: false}
	if overrides != nil {
		overrides(spec)
	}
	return catalog.ToolDescriptor{ID: "http-get-node", Description: "fetch", AllowedRoles: []string{"reader"}, LocalExec: spec}
}

func TestExecutorPostsARunRequestAndMapsASucceededEnvelope(t *testing.T) {
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 200, `{"type":"succeeded","result":{"status":200}}`, false
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 30, SecretReader: fakeSecretReader{},
	})

	tool := localTool(func(s *catalog.LocalExecSpec) { s.Env = map[string]string{"FOO": "bar"} })
	event := exec.Run(context.Background(), tool, "https://example.com", "")

	require.Equal(t, messaging.EventSucceeded, event.Type)
	require.JSONEq(t, `{"status":200}`, string(event.Result))
	require.NotNil(t, sidecar.lastRequest)
	require.Equal(t, "node", sidecar.lastRequest.Runtime)
	require.Equal(t, "p", sidecar.lastRequest.Package)
	require.Equal(t, "1.0.0", sidecar.lastRequest.Version)
	require.Equal(t, "https://example.com", sidecar.lastRequest.Input)
	require.False(t, sidecar.lastRequest.Network)
	require.Equal(t, map[string]string{"FOO": "bar"}, sidecar.lastRequest.Env)
}

func TestExecutorSetsSessionIDInEnvWhenGiven(t *testing.T) {
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 200, `{"type":"succeeded","result":"ok"}`, false
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 30, SecretReader: fakeSecretReader{},
	})

	tool := localTool(func(s *catalog.LocalExecSpec) { s.Env = map[string]string{"FOO": "bar"} })
	exec.Run(context.Background(), tool, "https://example.com", "chat-42")

	require.Equal(t, map[string]string{"FOO": "bar", "SESSION_ID": "chat-42"}, sidecar.lastRequest.Env)
}

func TestExecutorOmitsSessionIDWhenNotGiven(t *testing.T) {
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 200, `{"type":"succeeded","result":"ok"}`, false
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 30, SecretReader: fakeSecretReader{},
	})

	tool := localTool(func(s *catalog.LocalExecSpec) { s.Env = map[string]string{"FOO": "bar"} })
	exec.Run(context.Background(), tool, "https://example.com", "")

	require.Equal(t, map[string]string{"FOO": "bar"}, sidecar.lastRequest.Env)
}

// The engine's real secrets (e.g. its own OPENAI_API_KEY) must never leak
// into a LocalTool's env — only declared secretEnv entries do.
func TestExecutorResolvesSecretEnvAndPassesOnlyDeclaredEnv(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-orchestrator-secret")
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 200, `{"type":"succeeded","result":"ok"}`, false
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 30,
		SecretReader: fakeSecretReader{"s/k": "resolved-token"},
	})

	tool := localTool(func(s *catalog.LocalExecSpec) {
		s.Env = map[string]string{"FOO": "bar"}
		s.SecretEnv = []catalog.SecretEnvRef{{Name: "TOKEN", SecretName: "s", SecretKey: "k"}}
	})
	exec.Run(context.Background(), tool, "in", "")

	require.Equal(t, map[string]string{"FOO": "bar", "TOKEN": "resolved-token"}, sidecar.lastRequest.Env)
	_, leaked := sidecar.lastRequest.Env["OPENAI_API_KEY"]
	require.False(t, leaked)
}

func TestExecutorFailsClosedWhenAReferencedSecretIsMissing(t *testing.T) {
	dir := t.TempDir() // no sidecar listening at all — must never be reached
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: dir, DefaultTimeoutSeconds: 30, SecretReader: fakeSecretReader{},
	})

	tool := localTool(func(s *catalog.LocalExecSpec) {
		s.SecretEnv = []catalog.SecretEnvRef{{Name: "TOKEN", SecretName: "missing", SecretKey: "k"}}
	})
	event := exec.Run(context.Background(), tool, "in", "")

	require.Equal(t, messaging.EventFailed, event.Type)
	require.Equal(t, "secret_missing", event.Code)
}

func TestExecutorMapsAFailedEnvelope(t *testing.T) {
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 200, `{"type":"failed","code":"http_error","message":"boom"}`, false
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 30, SecretReader: fakeSecretReader{},
	})

	event := exec.Run(context.Background(), localTool(nil), "in", "")
	require.Equal(t, messaging.EventFailed, event.Type)
	require.Equal(t, "http_error", event.Code)
	require.Equal(t, "boom", event.Message)
}

func TestExecutorMapsANon2xxResponseToExecutorError(t *testing.T) {
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 500, "internal error", false
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 30, SecretReader: fakeSecretReader{},
	})

	event := exec.Run(context.Background(), localTool(nil), "in", "")
	require.Equal(t, messaging.EventFailed, event.Type)
	require.Equal(t, "executor_error", event.Code)
}

func TestExecutorTimesOutWhenTheSidecarNeverResponds(t *testing.T) {
	sidecar := startSidecar(t, "node", func(localtool.RunRequest) (int, string, bool) {
		return 0, "", true
	})
	exec := localtool.NewExecutor(localtool.Options{
		SocketDir: sidecar.socketDir, DefaultTimeoutSeconds: 0, BackstopBufferSeconds: 0.1, SecretReader: fakeSecretReader{},
	})

	start := time.Now()
	event := exec.Run(context.Background(), localTool(func(s *catalog.LocalExecSpec) { s.TimeoutSeconds = 0 }), "in", "")
	require.Less(t, time.Since(start), 5*time.Second, "must not block on a hung sidecar past its own backstop")
	require.Equal(t, messaging.EventFailed, event.Type)
	require.Equal(t, "executor_error", event.Code)
}
