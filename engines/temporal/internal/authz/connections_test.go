package authz_test

import (
	"context"
	"regexp"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// The Connections page (agent-controller ADR 0046) stands in for a provider's
// own link flow for chat callers, and only for them: one link per turn that
// covers every missing provider, with every invariant a direct link has. The
// principal still goes first, and each provider is anchored against the exact
// subject it was read under. PARITY: authorization-service.test.ts.

const connectionsPage = "https://gw.example/connections"

func newPageService(t *testing.T, wait time.Duration) (*authz.Service, *identitylink.Fake) {
	t.Helper()
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	return authz.New(authz.Deps{
		Links: links, Secret: &fakeSecrets{}, WaitForLink: wait,
		StartRetryDelay: time.Microsecond,
		ConnectionsURL:  connectionsPage,
	}), links
}

var markdownLink = regexp.MustCompile(`\]\(https://[^)]+\)`)

// chatCallerWithPrincipal has linked GitHub already, so no principal step runs.
func chatCallerWithPrincipal() authz.Identity {
	id := chatCaller()
	id.Principal = "github:imaustink"
	return id
}

func TestOneConnectionsLinkCoversEveryMissingProvider(t *testing.T) {
	svc, links := newPageService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude", "claude-remote"},
		Identity:          chatCallerWithPrincipal(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Equal(t,
		[]string{"](https://gw.example/connections/link?need=claude%2Cclaude-remote)"},
		markdownLink.FindAllString(verdict.Message, -1),
		"one link, naming both providers, offered once")
	require.Contains(t, verdict.Message, "[connect your Claude and Claude Remote Control accounts]")
	require.Empty(t, links.Started, "the page starts each flow itself; nothing is started here")

	// Anchored at the principal the credential was read under -- re-deriving
	// it as the raw subject is upstream's PR #144 re-auth loop.
	require.Equal(t, "claude", verdict.Pending.Provider)
	require.Equal(t, "github:imaustink", verdict.Pending.Subject)
	require.Equal(t, identitylink.FlowPage, verdict.Pending.Flow)
}

func TestDeferredProvidersResolveInTheSameTurnUnderTheirOwnSubject(t *testing.T) {
	svc, links := newPageService(t, time.Minute)
	links.CompleteOnWait["claude"] = identitylink.Token{Value: claudeToken}
	links.CompleteOnWait["claude-remote"] = identitylink.Token{Value: `{"claudeAiOauth":{}}`}

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude", "claude-remote"},
		Identity:          chatCallerWithPrincipal(),
		WaitForLink:       true,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Contains(t, verdict.EnvVarNames, "CLAUDE_CODE_OAUTH_TOKEN")
	require.Contains(t, verdict.EnvVarNames, "CLAUDE_LOGIN_CREDENTIALS_JSON")

	// The fake files a waited-for token under the subject it was waited on.
	got, err := links.Token(context.Background(), "claude", "github:imaustink")
	require.NoError(t, err)
	require.NotNil(t, got, "waited on at the principal, not the chat subject")
}

func TestOnceAProviderDoesNotLandTheRestParkWithoutWaiting(t *testing.T) {
	svc, links := newPageService(t, time.Minute)
	// Would resolve if it were waited on.
	links.CompleteOnWait["claude-remote"] = identitylink.Token{Value: `{}`}

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude", "claude-remote"},
		Identity:          chatCallerWithPrincipal(),
		WaitForLink:       true,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Contains(t, links.CompleteOnWait, "claude-remote", "never waited on")
}

func TestAPendingPrincipalOnThePageNamesWhatFollowsAndAssessesNothing(t *testing.T) {
	svc, links := newPageService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Equal(t,
		[]string{"](https://gw.example/connections/link?need=github%2Cclaude)"},
		markdownLink.FindAllString(verdict.Message, -1))
	require.Equal(t, authz.PrincipalProvider, verdict.Pending.Provider)
	require.Equal(t, "openwebui:1234", verdict.Pending.Subject)
	require.Empty(t, links.Started)
}

func TestThePrincipalLandingInTurnCarriesOnUnderIt(t *testing.T) {
	svc, links := newPageService(t, time.Minute)
	links.CompleteOnWait["github"] = identitylink.Token{Value: githubToken, GitHubLogin: "ImAustink"}
	links.CompleteOnWait["claude"] = identitylink.Token{Value: claudeToken}

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude"},
		Identity:          chatCaller(),
		WaitForLink:       true,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, "github:imaustink", verdict.Principal)
	require.NotContains(t, verdict.EnvVarNames, "GITHUB_TOKEN", "the principal step stays link-only")
}

// A webhook relay's subject is shared and has no browser session behind it;
// the page could never find it.
func TestTheConnectionsPageIsOnlyForOpenWebUICallers(t *testing.T) {
	svc, links := newPageService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.NotContains(t, verdict.Message, "/connections")
	require.Len(t, links.Started, 1)
	require.Equal(t, "github:imaustink", links.Started[0].Subject)
}

// A caller that asked for the device flow has no browser to send to the page.
func TestTheConnectionsPageNeverReplacesAnAskedForDeviceFlow(t *testing.T) {
	svc, links := newPageService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude"},
		Identity:          chatCallerWithPrincipal(),
		Flow:              identitylink.FlowDevice,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.NotContains(t, verdict.Message, "/connections")
	require.Len(t, links.Started, 1)
	require.Equal(t, identitylink.FlowDevice, links.Started[0].Flow)
}

func TestConnectionsPageStartBuildsTheDeepLink(t *testing.T) {
	started, ok := authz.ConnectionsPageStart("https://gw.example/connections/", []string{"github", "claude"})
	require.True(t, ok)
	require.Equal(t, "https://gw.example/connections/link?need=github%2Cclaude", started.PageURL)

	_, ok = authz.ConnectionsPageStart("not a url", []string{"github"})
	require.False(t, ok)
}
