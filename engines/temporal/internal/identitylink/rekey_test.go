package identitylink_test

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// The route's real response shape (integration-gateway's ClaudeAuthStore.rekey
// union: "moved" | "not-found" | "occupied"), not a boolean `moved` field —
// see Rekey's doc comment for the bug this pins: a client reading `moved`
// decoded false for every response, including a real "moved", so adopt()
// believed every rekey failed and always fell through to re-prompting the
// caller instead of ever moving their credential.
func newRekeyServer(t *testing.T, status string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/claude-auth/api/rekey", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": status})
	}))
}

func TestRekey_Moved(t *testing.T) {
	server := newRekeyServer(t, "moved")
	defer server.Close()
	client := identitylink.New(identitylink.Options{BaseURL: server.URL})

	moved, err := client.Rekey(t.Context(), identitylink.ProviderClaude, "openwebui:alice", "github:alice")
	require.NoError(t, err)
	require.True(t, moved)
}

func TestRekey_NotFound(t *testing.T) {
	server := newRekeyServer(t, "not-found")
	defer server.Close()
	client := identitylink.New(identitylink.Options{BaseURL: server.URL})

	moved, err := client.Rekey(t.Context(), identitylink.ProviderClaude, "openwebui:alice", "github:alice")
	require.NoError(t, err)
	require.False(t, moved)
}

func TestRekey_Occupied(t *testing.T) {
	server := newRekeyServer(t, "occupied")
	defer server.Close()
	client := identitylink.New(identitylink.Options{BaseURL: server.URL})

	moved, err := client.Rekey(t.Context(), identitylink.ProviderClaude, "openwebui:alice", "github:alice")
	require.NoError(t, err)
	require.False(t, moved)
}

func TestRekey_NonClaudeProviderNeverCallsOut(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("github must never be rekeyed -- it produces the mapping, keying it by principal would be circular")
	}))
	defer server.Close()
	client := identitylink.New(identitylink.Options{BaseURL: server.URL})

	moved, err := client.Rekey(t.Context(), identitylink.ProviderGitHub, "openwebui:alice", "github:alice")
	require.NoError(t, err)
	require.False(t, moved)
}
