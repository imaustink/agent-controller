package activities_test

import (
	"bytes"
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/testsuite"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/identitylink"
	"github.com/aktisai/orchestrator/engines/temporal/internal/temporal/activities"
)

type recordingSecrets struct{ data map[string]string }

func (r *recordingSecrets) WriteRunCredentials(_ context.Context, _ string, data map[string]string) (string, error) {
	r.data = data
	return "run-creds", nil
}

// Every pre-flight decision is on the audit trail before anything launches
// (docs/adr/0049 §3), with a decision id the launch record joins on, and no
// credential value anywhere in it.
func TestAuthorizeWritesAnAuditRecordWithoutTokenMaterial(t *testing.T) {
	const claudeToken = "sk-ant-oat-AUDITSECRET"
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	links.Set(identitylink.ProviderClaude, "openwebui:1234", identitylink.Token{Value: claudeToken})
	secrets := &recordingSecrets{}
	acts := &activities.AuthorizeActivities{Service: authz.New(authz.Deps{Links: links, Secret: secrets})}

	var buf bytes.Buffer
	defer audit.SetOutput(&buf, time.Now)()

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(acts)
	val, err := env.ExecuteActivity(acts.Authorize, activities.AuthorizeInput{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"github", "claude"},
		Caller:            activities.Caller{Subject: "openwebui:1234", PerUser: true},
		DefaultIdentity:   "agent",
		TargetRepository:  "acme/widgets",
	})
	require.NoError(t, err)
	var verdict authz.Verdict
	require.NoError(t, val.Get(&verdict))
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.NotEmpty(t, verdict.DecisionID)
	require.Equal(t, claudeToken, secrets.data["CLAUDE_CODE_OAUTH_TOKEN"], "the credential did reach the Secret")

	line := strings.TrimSpace(buf.String())
	require.NotContains(t, line, claudeToken, "an audit record never carries a credential")
	var rec map[string]any
	require.NoError(t, json.Unmarshal([]byte(line), &rec))
	require.Equal(t, "agent-authorization", rec["kind"])
	require.Equal(t, "authorized", rec["outcome"])
	require.Equal(t, verdict.DecisionID, rec["decisionId"])
	require.Equal(t, "chat", rec["entryPoint"])
	require.Equal(t, "openwebui:1234", rec["launchedBy"])
	require.Equal(t, "agent", rec["identityMode"])
	require.Equal(t, "default", rec["identityModeSource"])

	// The workflow rebuilds the same view to carry to the launcher.
	carried := activities.LaunchRecord(activities.AuthorizeInput{
		AgentID: "claude-code-swe-agent", IdentityProviders: []string{"github", "claude"},
		Caller: activities.Caller{Subject: "openwebui:1234", PerUser: true}, DefaultIdentity: "agent",
		TargetRepository: "acme/widgets",
	}, verdict)
	carriedJSON, _ := json.Marshal(carried)
	for k, v := range map[string]any{"decisionId": verdict.DecisionID, "identityMode": "agent", "entryPoint": "chat"} {
		require.Contains(t, string(carriedJSON), `"`+k+`":"`+v.(string)+`"`)
	}
}

// A refusal is recorded too: the audit trail is every decision, not every
// launch.
func TestARefusalIsAudited(t *testing.T) {
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	acts := &activities.AuthorizeActivities{Service: authz.New(authz.Deps{Links: links, Secret: &recordingSecrets{}})}
	var buf bytes.Buffer
	defer audit.SetOutput(&buf, time.Now)()

	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestActivityEnvironment()
	env.RegisterActivity(acts)
	_, err = env.ExecuteActivity(acts.Authorize, activities.AuthorizeInput{
		AgentID: "swe", IdentityProviders: []string{"github"},
		Caller:          activities.Caller{Subject: "oidc:integration-gateway"},
		DefaultIdentity: "delegated", TriggerName: "ai-triage", SenderLogin: "alice",
	})
	require.NoError(t, err)
	var rec map[string]any
	require.NoError(t, json.Unmarshal(bytes.TrimSpace(buf.Bytes()), &rec))
	require.Equal(t, "refused", rec["outcome"])
	require.Equal(t, "webhook", rec["entryPoint"])
	require.Equal(t, "ai-triage", rec["trigger"])
	require.Equal(t, map[string]any{"provider": "github", "login": "alice"}, rec["sender"])
	require.Equal(t, "delegated", rec["requestedIdentityMode"])
	require.Nil(t, rec["identityMode"], "a run mode is only recorded for a launch that goes ahead")
}
