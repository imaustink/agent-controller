package authz_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/identitylink"
)

// docs/adr/0049 §5-§6: a webhook sender integration-gateway resolved to a
// linked subject is acted AS, through that subject's links, on the shared
// relay identity -- and one who is not gets a structured identity error,
// never a link prompt.

const senderSubject = "openwebui:alice"

func webhookSender(delegated, status string) (authz.Identity, func(*authz.Request)) {
	id := webhookCaller()
	id.DelegatedSubject = delegated
	return id, func(r *authz.Request) {
		r.SenderLogin = "alice"
		r.SenderAccountID = "583231"
		r.SenderSubjectStatus = status
	}
}

func newDelegatedService(t *testing.T, repos *fakeRepos) (*authz.Service, *identitylink.Fake, *fakeSecrets) {
	t.Helper()
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	secrets := &fakeSecrets{}
	return authz.New(authz.Deps{
		Links: links, Secret: secrets, StartRetryDelay: time.Microsecond, Repos: repos,
		ConnectionsURL: "https://gw.example/connections",
	}), links, secrets
}

func TestALinkedWebhookSenderIsActedAsThroughTheirDelegatedSubject(t *testing.T) {
	for _, mode := range []string{"hybrid", "delegated", ""} {
		repos := &fakeRepos{access: map[string]authz.RepoAccess{readableRepo: authz.RepoReadable}}
		svc, links, secrets := newDelegatedService(t, repos)
		links.Set(identitylink.ProviderGitHub, senderSubject, identitylink.Token{Value: githubToken, GitHubLogin: "alice"})

		id, withSender := webhookSender(senderSubject, "linked")
		req := authz.Request{
			AgentID: "claude-code-swe-agent", IdentityProviders: []string{"github"},
			Identity: id, TargetRepository: readableRepo, DefaultIdentity: mode,
		}
		withSender(&req)
		verdict, err := svc.Authorize(context.Background(), req)
		require.NoError(t, err, "mode=%q", mode)
		require.Equal(t, authz.KindAuthorized, verdict.Kind, "mode=%q", mode)

		want := authz.IdentityMode(mode)
		if mode == "" {
			want = authz.ModeHybrid // inferred, and now satisfiable as the sender
		}
		require.Equal(t, want, verdict.IdentityMode)
		require.Equal(t, githubToken, secrets.written["GITHUB_TOKEN"], "the SENDER's token, from their delegated subject")
		require.Equal(t, []repoCheck{{githubToken, readableRepo}}, repos.checks, "the read gate runs on the sender's own token")
		require.Empty(t, links.Started, "nothing interactive ever runs for a webhook sender")
	}
}

// The sender resolved to a subject that has no GitHub link (unlinked since):
// reported with the Connections page link, and no flow started under anyone.
func TestADelegatedSenderWithoutALinkGetsAnIdentityErrorNotAPrompt(t *testing.T) {
	svc, links, secrets := newDelegatedService(t, &fakeRepos{access: map[string]authz.RepoAccess{}})
	id, withSender := webhookSender(senderSubject, "linked")
	req := authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: []string{"github"},
		Identity: id, TargetRepository: readableRepo, DefaultIdentity: "delegated",
		Flow: identitylink.FlowDevice,
	}
	withSender(&req)
	verdict, err := svc.Authorize(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, verdict.Kind)
	require.NotNil(t, verdict.IdentityError)
	ie := verdict.IdentityError
	require.Equal(t, authz.CodeIdentityLinkRequired, ie.Code)
	require.Equal(t, &authz.IdentitySender{Provider: "github", Login: "alice", AccountID: "583231"}, ie.Sender)
	require.Equal(t, []authz.MissingIdentity{{
		Provider: "github", Label: "GitHub", LinkURL: "https://gw.example/connections/link?need=github",
	}}, ie.Missing)
	require.Contains(t, ie.Message, "alice: link your GitHub account so claude-code-swe-agent can act as you: https://gw.example/connections/link?need=github")
	require.NotContains(t, ie.Message, senderSubject, "an identity error never names a subject")
	require.Empty(t, links.Started)
	require.Zero(t, secrets.calls)
}

// A sender the gateway could not resolve to exactly one subject.
func TestAnUnresolvedSenderGetsTheMatchingIdentityError(t *testing.T) {
	for status, code := range map[string]string{
		"unlinked":    authz.CodeIdentityLinkRequired,
		"ambiguous":   authz.CodeIdentityAmbiguous,
		"unavailable": authz.CodeIdentityUnavailable,
		"":            authz.CodeIdentityUnavailable,
	} {
		svc, links, _ := newDelegatedService(t, &fakeRepos{})
		id, withSender := webhookSender("", status)
		req := authz.Request{
			AgentID: "swe", IdentityProviders: []string{"github"}, Identity: id,
			TargetRepository: readableRepo, DefaultIdentity: "hybrid",
		}
		withSender(&req)
		verdict, err := svc.Authorize(context.Background(), req)
		require.NoError(t, err)
		require.Equal(t, authz.KindRefused, verdict.Kind, "status=%q", status)
		require.Equal(t, code, verdict.IdentityError.Code, "status=%q", status)
		require.Empty(t, links.Started)
	}
}

// Inferred hybrid with an unresolved sender keeps the pre-0049 webhook
// behaviour exactly: run as the App, no identity error.
func TestAnInferredModeWithAnUnresolvedSenderStillRunsAsTheAgent(t *testing.T) {
	svc, _, secrets := newDelegatedService(t, &fakeRepos{})
	id, withSender := webhookSender("", "unlinked")
	req := authz.Request{AgentID: "swe", IdentityProviders: []string{"github"}, Identity: id, TargetRepository: readableRepo}
	withSender(&req)
	verdict, err := svc.Authorize(context.Background(), req)
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, authz.ModeAgent, verdict.IdentityMode)
	require.NotContains(t, secrets.written, "GITHUB_TOKEN")
}

// The accept-phase check reports exactly what the run's pre-flight would
// refuse with, and nothing for a launch it would allow.
func TestCheckIdentityMatchesThePreflightAndNeverStartsAFlow(t *testing.T) {
	svc, links, secrets := newDelegatedService(t, &fakeRepos{})
	id, withSender := webhookSender(senderSubject, "linked")
	req := authz.Request{AgentID: "swe", IdentityProviders: []string{"github", "claude"}, Identity: id, DefaultIdentity: "hybrid"}
	withSender(&req)

	ie := svc.CheckIdentity(context.Background(), req)
	require.NotNil(t, ie)
	require.Equal(t, authz.CodeIdentityLinkRequired, ie.Code)
	require.Equal(t, []string{"github"}, func() (out []string) {
		for _, m := range ie.Missing {
			out = append(out, m.Provider)
		}
		return
	}(), "runtime providers are never the sender's to link here")

	links.Set(identitylink.ProviderGitHub, senderSubject, identitylink.Token{Value: githubToken, GitHubLogin: "alice"})
	require.Nil(t, svc.CheckIdentity(context.Background(), req), "linked now")

	agentMode := req
	agentMode.DefaultIdentity = "agent"
	require.Nil(t, svc.CheckIdentity(context.Background(), agentMode), "agent mode needs no sender link")

	require.Empty(t, links.Started)
	require.Zero(t, secrets.calls)
}
