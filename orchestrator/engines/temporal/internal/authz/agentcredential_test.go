package authz_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/identitylink"
)

// docs/adr/0049 step 5: a Tool whose defaultIdentity is agent presents each
// resource provider's agentCredential instead of the caller's link.

type fakeAgentCreds map[string]*authz.AgentCredential

func (f fakeAgentCreds) AgentCredential(_ context.Context, provider string) (*authz.AgentCredential, error) {
	return f[provider], nil
}

const jiraAgentToken = "jira-OPERATOR-SECRET"

func agentIdentityService(t *testing.T, creds authz.AgentCredentialSource) (*authz.Service, *identitylink.Fake, *fakeSecrets) {
	t.Helper()
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	secrets := &fakeSecrets{}
	return authz.New(authz.Deps{Links: links, Secret: secrets, AgentCredentials: creds}), links, secrets
}

func TestAgentIdentityToolUsesTheAgentCredentialWithoutACallerLink(t *testing.T) {
	svc, links, secrets := agentIdentityService(t, fakeAgentCreds{
		"jira": {EnvVar: "JIRA_TOKEN", Value: jiraAgentToken},
	})

	v, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID:           "jira-tool",
		IdentityProviders: []string{"jira"},
		Identity:          chatCaller(),
		ToolIdentity:      authz.ToolIdentityAgent,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, v.Kind, v.Error)
	require.Equal(t, authz.ModeAgent, v.IdentityMode)
	require.Equal(t, []string{"JIRA_TOKEN"}, v.EnvVarNames)
	require.Equal(t, jiraAgentToken, secrets.written["JIRA_TOKEN"])
	require.Equal(t, []authz.LaunchCredential{{Provider: "jira", Read: "agent", Write: "agent"}}, v.Credentials)
	require.Empty(t, links.Started, "nothing about the caller was asked for")

	encoded, err := json.Marshal(v)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), jiraAgentToken, "the value stays in the Secret")
}

// A known provider keeps its fixed env var, so a tool reads GITHUB_TOKEN in
// either identity.
func TestAgentIdentityKeepsAKnownProvidersEnvVar(t *testing.T) {
	svc, _, secrets := agentIdentityService(t, fakeAgentCreds{
		"github": {EnvVar: "SOMETHING_ELSE", Value: "ghs_operator"},
	})
	v, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "gh-tool", IdentityProviders: []string{"github"}, Identity: chatCaller(),
		ToolIdentity: authz.ToolIdentityAgent,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, v.Kind, v.Error)
	require.Equal(t, "ghs_operator", secrets.written["GITHUB_TOKEN"])
}

func TestAgentIdentityWithoutAnAgentCredentialIsMisconfigured(t *testing.T) {
	svc, _, secrets := agentIdentityService(t, fakeAgentCreds{})
	v, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "jira-tool", IdentityProviders: []string{"jira"}, Identity: chatCaller(),
		ToolIdentity: authz.ToolIdentityAgent,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindMisconfigured, v.Kind)
	require.Contains(t, v.Error, "no agentCredential")
	require.Zero(t, secrets.calls)
}

// The model credential is always the caller's, even for an agent-identity tool.
func TestAgentIdentityStillResolvesARuntimeProviderFromTheCaller(t *testing.T) {
	svc, links, secrets := agentIdentityService(t, fakeAgentCreds{
		"jira": {EnvVar: "JIRA_TOKEN", Value: jiraAgentToken},
	})
	links.Set(identitylink.ProviderClaude, "openwebui:1234", identitylink.Token{Value: claudeToken})
	v, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "t", IdentityProviders: []string{"jira", "claude"}, Identity: chatCaller(),
		ToolIdentity: authz.ToolIdentityAgent,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, v.Kind, v.Error)
	require.Equal(t, claudeToken, secrets.written["CLAUDE_CODE_OAUTH_TOKEN"])
	require.Contains(t, v.Credentials, authz.LaunchCredential{Provider: "claude", Read: "caller", Write: "caller"})
}

// The same read-only refusal in agent identity: the operator's credential can
// write too.
func TestAgentIdentityGitHubToolIsRefusedOnAReadOnlyTurn(t *testing.T) {
	svc, _, secrets := agentIdentityService(t, fakeAgentCreds{"github": {Value: "ghs_operator"}})
	v, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "gh-tool", IdentityProviders: []string{"github"}, Identity: chatCaller(),
		ToolIdentity: authz.ToolIdentityAgent, ReadOnly: true,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, v.Kind)
	require.Contains(t, v.Message, "agent's own credential")
	require.Zero(t, secrets.calls)
}

// A delegated tool is unchanged: the caller's link, never the agentCredential.
func TestDelegatedToolIgnoresTheAgentCredential(t *testing.T) {
	svc, _, _ := agentIdentityService(t, fakeAgentCreds{"github": {Value: "ghs_operator"}})
	v, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "gh-tool", IdentityProviders: []string{"github"}, Identity: chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, v.Kind)
}

// ── the Kubernetes source ──────────────────────────────────────────────────

func TestK8sAgentCredentialsRequiresTheOptInLabel(t *testing.T) {
	idp := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "core.aktis.ai/v1alpha1", "kind": "IdentityProvider",
		"metadata": map[string]any{"name": "jira", "namespace": "ns"},
		"spec": map[string]any{
			"envVar": "JIRA_TOKEN", "label": "Jira",
			"agentCredential": map[string]any{"secretRef": map[string]any{"name": "jira-bot", "key": "token"}},
		},
	}}
	secret := func(labelled bool) *unstructured.Unstructured {
		meta := map[string]any{"name": "jira-bot", "namespace": "ns"}
		if labelled {
			meta["labels"] = map[string]any{authz.AgentCredentialSecretLabel: "true"}
		}
		return &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "v1", "kind": "Secret", "metadata": meta,
			"data": map[string]any{"token": base64.StdEncoding.EncodeToString([]byte(jiraAgentToken))},
		}}
	}
	gvrs := map[schema.GroupVersionResource]string{
		{Group: "core.aktis.ai", Version: "v1alpha1", Resource: "identityproviders"}: "IdentityProviderList",
		{Version: "v1", Resource: "secrets"}:                                         "SecretList",
	}

	src := authz.NewK8sAgentCredentials(dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), gvrs, idp, secret(true)), "ns")
	cred, err := src.AgentCredential(context.Background(), "jira")
	require.NoError(t, err)
	require.Equal(t, &authz.AgentCredential{EnvVar: "JIRA_TOKEN", Value: jiraAgentToken}, cred)

	src = authz.NewK8sAgentCredentials(dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), gvrs, idp, secret(false)), "ns")
	_, err = src.AgentCredential(context.Background(), "jira")
	require.ErrorContains(t, err, "not labelled")

	cred, err = src.AgentCredential(context.Background(), "nobody")
	require.NoError(t, err)
	require.Nil(t, cred, "no IdentityProvider means no agent credential, not an error")
}
