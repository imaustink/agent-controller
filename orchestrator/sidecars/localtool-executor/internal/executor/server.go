package executor

import (
	"encoding/json"
	"io"
	"net/http"
)

// Server handles POST /run over the pod-local unix socket. One Server per
// runtime process; a request for a different runtime is rejected by validation.
type Server struct {
	cfg      Config
	resolver *resolver
}

// NewServer builds a Server for the configured runtime.
func NewServer(cfg Config) *Server {
	return &Server{cfg: cfg, resolver: newResolver(cfg)}
}

// Handler returns the HTTP mux (POST /run + GET /healthz).
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /run", s.handleRun)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	return mux
}

func (s *Server) handleRun(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
	if err != nil {
		http.Error(w, "read error", http.StatusBadRequest)
		return
	}
	var req RunRequest
	if err := json.Unmarshal(body, &req); err != nil {
		http.Error(w, "invalid JSON body", http.StatusBadRequest)
		return
	}

	// Integrity re-check (defense in depth). A validation failure is a real,
	// user-visible tool failure -> 200 + failed envelope (not a transport
	// error), so the orchestrator surfaces the reason rather than a generic
	// executor_error.
	if reason := s.cfg.validateRequest(req); reason != "" {
		writeEnvelope(w, failedEnvelope("invalid_request", reason))
		return
	}

	cmd, err := s.resolver.resolve(r.Context(), req)
	if err != nil {
		writeEnvelope(w, failedEnvelope("fetch_error", err.Error()))
		return
	}

	writeEnvelope(w, runSandboxed(r.Context(), s.cfg, req, cmd))
}

func writeEnvelope(w http.ResponseWriter, env Envelope) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(http.StatusOK)
	_ = json.NewEncoder(w).Encode(env)
}
