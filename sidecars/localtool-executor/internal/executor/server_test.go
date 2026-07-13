package executor

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleRunRejectsBadJSON(t *testing.T) {
	srv := NewServer(Config{Runtime: "node"})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/run", strings.NewReader("{not json"))
	srv.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}
}

func TestHandleRunReturnsInvalidRequestEnvelope(t *testing.T) {
	srv := NewServer(Config{Runtime: "node"})
	// Unpinned version -> validation failure -> 200 + failed envelope (a
	// user-visible tool failure, not a transport error).
	body, _ := json.Marshal(RunRequest{Runtime: "node", Package: "p", Version: "latest", Input: "x"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/run", strings.NewReader(string(body))))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rec.Code)
	}
	var env Envelope
	if err := json.Unmarshal(rec.Body.Bytes(), &env); err != nil {
		t.Fatal(err)
	}
	if env.Type != "failed" || env.Code != "invalid_request" {
		t.Fatalf("got %+v", env)
	}
}

func TestHealthz(t *testing.T) {
	srv := NewServer(Config{Runtime: "node"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("healthz status = %d", rec.Code)
	}
}
