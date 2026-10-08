package activities_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

func mcpTool(identityProviders ...string) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID:                "mcp:github/search_issues",
		Description:       "Search GitHub issues",
		IdentityProviders: identityProviders,
		MCPExec: &catalog.MCPExecSpec{
			ServerRef:      "github-mcp",
			RemoteToolName: "search_issues",
		},
	}
}

// staticResolver returns a fixed token (or none) for any provider.
type staticResolver struct{ token string }

func (r staticResolver) DelegatedToken(
	_ context.Context, _ activities.Caller, _ []string,
) (activities.DelegatedCredential, error) {
	return activities.DelegatedCredential{Token: r.token}, nil
}

func (r staticResolver) DelegatedTokens(
	_ context.Context, _ activities.Caller, providers []string,
) (map[string]activities.DelegatedCredential, error) {
	out := map[string]activities.DelegatedCredential{}
	for _, p := range providers {
		out[p] = activities.DelegatedCredential{Token: r.token}
	}
	return out, nil
}

// capturedCall is what the broker stub saw on the one request.
type capturedCall struct {
	path            string
	authHeader      string
	delegatedHeader string
	hadDelegated    bool
	body            string
}

// mcpBrokerStub answers one tools/call with the given status/body and records
// what it received.
func mcpBrokerStub(t *testing.T, status int, body any) (*httptest.Server, *capturedCall, *bool) {
	t.Helper()
	var got capturedCall
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		raw, _ := io.ReadAll(r.Body)
		got = capturedCall{
			path:            r.URL.Path,
			authHeader:      r.Header.Get("Authorization"),
			delegatedHeader: r.Header.Get("x-delegated-token"),
			hadDelegated:    r.Header.Values("x-delegated-token") != nil,
			body:            string(raw),
		}
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		if body != nil {
			require.NoError(t, json.NewEncoder(w).Encode(body))
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &got, &called
}

func mcpActivities(srv *httptest.Server, resolver activities.DelegatedCredentialResolver) *activities.MCPActivities {
	return &activities.MCPActivities{
		Credentials: resolver,
		BrokerURL:   srv.URL,
		BrokerToken: "orch",
	}
}

func TestRunMCPToolProxiesWithDelegatedTokenAndReturnsResult(t *testing.T) {
	srv, got, _ := mcpBrokerStub(t, http.StatusOK, map[string]any{"result": "found 3 issues", "isError": false})
	a := mcpActivities(srv, staticResolver{token: "user-token"})

	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller:    activities.Caller{Subject: "user:1", Roles: []string{"engineering"}},
		Tool:      mcpTool("github"),
		Arguments: `{"query":"is:open"}`,
	})
	require.NoError(t, err)
	require.True(t, out.Succeeded)
	require.Equal(t, "found 3 issues", out.Result)
	require.False(t, out.NeedsLink)

	require.Equal(t, "/servers/github-mcp/tools/search_issues/call", got.path)
	require.Equal(t, "Bearer orch", got.authHeader)
	require.Equal(t, "user-token", got.delegatedHeader, "the caller's own delegated token")
	require.JSONEq(t, `{"arguments":{"query":"is:open"}}`, got.body)
}

func TestRunMCPToolFailsClosedWhenTokenMissing(t *testing.T) {
	srv, _, called := mcpBrokerStub(t, http.StatusOK, map[string]any{"result": "x"})
	a := mcpActivities(srv, staticResolver{token: ""}) // no linked credential

	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller:    activities.Caller{Subject: "user:1", Roles: []string{"engineering"}},
		Tool:      mcpTool("github"),
		Arguments: `{"query":"x"}`,
	})
	require.NoError(t, err)
	require.True(t, out.NeedsLink)
	require.False(t, out.Succeeded)
	require.False(t, *called, "fail closed: the broker is never called with a fallback credential")
}

func TestRunMCPToolNoIdentityProvidersSendsNoDelegatedHeader(t *testing.T) {
	srv, got, _ := mcpBrokerStub(t, http.StatusOK, map[string]any{"result": "ok", "isError": false})
	a := mcpActivities(srv, staticResolver{token: "unused"})

	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller:    activities.Caller{Subject: "user:1", Roles: []string{"engineering"}},
		Tool:      mcpTool(), // server declares no identityProviders
		Arguments: `{}`,
	})
	require.NoError(t, err)
	require.True(t, out.Succeeded)
	require.False(t, got.hadDelegated, "a server needing no identity gets no delegated token")
}

func TestRunMCPToolToolLevelErrorIsProseNotFailure(t *testing.T) {
	srv, _, _ := mcpBrokerStub(t, http.StatusOK, map[string]any{"result": "repo not found", "isError": true})
	a := mcpActivities(srv, staticResolver{token: "t"})

	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller:    activities.Caller{Subject: "user:1", Roles: []string{"engineering"}},
		Tool:      mcpTool("github"),
		Arguments: `{}`,
	})
	require.NoError(t, err, "a tool-level error is an answer, not an activity failure")
	require.False(t, out.Succeeded)
	require.Equal(t, "repo not found", out.Result)
}

func TestRunMCPToolNon200IsProse(t *testing.T) {
	srv, _, _ := mcpBrokerStub(t, http.StatusForbidden, map[string]any{"message": "token expired"})
	a := mcpActivities(srv, staticResolver{token: "t"})

	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller:    activities.Caller{Subject: "user:1", Roles: []string{"engineering"}},
		Tool:      mcpTool("github"),
		Arguments: `{}`,
	})
	require.NoError(t, err)
	require.False(t, out.Succeeded)
	require.Contains(t, out.Result, "403")
	require.Contains(t, out.Result, "token expired")
}

func TestRunMCPToolBrokerUnreachableIsError(t *testing.T) {
	a := &activities.MCPActivities{
		Credentials: staticResolver{token: "t"},
		BrokerURL:   "http://127.0.0.1:1", // nothing listening
		BrokerToken: "orch",
	}
	_, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller:    activities.Caller{Subject: "user:1", Roles: []string{"engineering"}},
		Tool:      mcpTool("github"),
		Arguments: `{}`,
	})
	require.Error(t, err, "broker unreachable is a real error, not prose")
}
