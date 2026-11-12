package activities_test

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/activities"
)

type agentCreds map[string]*authz.AgentCredential

func (a agentCreds) AgentCredential(_ context.Context, p string) (*authz.AgentCredential, error) {
	return a[p], nil
}

// docs/adr/0049 step 5: an agent-identity MCPTool presents the provider's
// agentCredential, never the caller's link, and the call is on the record.
func TestRunMCPToolInAgentIdentityPresentsTheAgentCredential(t *testing.T) {
	var buf bytes.Buffer
	defer audit.SetOutput(&buf, time.Now)()

	srv, got, _ := mcpBrokerStub(t, http.StatusOK, map[string]any{"result": "ok", "isError": false})
	a := mcpActivities(srv, staticResolver{token: "caller-token"})
	a.AgentCredentials = agentCreds{"atlassian": {EnvVar: "ATLASSIAN_TOKEN", Value: "operator-token"}}

	tool := mcpTool("atlassian")
	tool.DefaultIdentity = authz.ToolIdentityAgent
	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller: activities.Caller{Subject: "openwebui:7", PerUser: true}, Tool: tool, Arguments: `{}`,
	})
	require.NoError(t, err)
	require.True(t, out.Succeeded)
	require.Equal(t, "operator-token", got.delegatedHeader)

	var rec map[string]any
	require.NoError(t, json.Unmarshal(buf.Bytes(), &rec))
	require.Equal(t, "tool-authorization", rec["kind"])
	require.Equal(t, tool.ID, rec["tool"])
	require.Equal(t, "openwebui:7", rec["launchedBy"])
	require.Equal(t, "agent", rec["identityMode"])
	require.NotContains(t, buf.String(), "operator-token", "identifiers only")
}

func TestRunMCPToolInAgentIdentityFailsClosedWithoutACredential(t *testing.T) {
	var buf bytes.Buffer
	defer audit.SetOutput(&buf, time.Now)()

	srv, _, called := mcpBrokerStub(t, http.StatusOK, map[string]any{"result": "x"})
	a := mcpActivities(srv, staticResolver{token: "caller-token"})
	a.AgentCredentials = agentCreds{}

	tool := mcpTool("atlassian")
	tool.DefaultIdentity = authz.ToolIdentityAgent
	out, err := a.RunMCPTool(context.Background(), activities.RunMCPToolInput{
		Caller: activities.Caller{Subject: "openwebui:7"}, Tool: tool, Arguments: `{}`,
	})
	require.NoError(t, err)
	require.False(t, out.Succeeded)
	require.Contains(t, out.Result, "agentCredential")
	require.False(t, *called, "never falls back to the caller's token")
	require.Contains(t, buf.String(), `"outcome":"misconfigured"`)
}
