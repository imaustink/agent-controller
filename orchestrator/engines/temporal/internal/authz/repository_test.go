package authz_test

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// fakeRepos answers the read gate from a fixed table, recording each check.
type fakeRepos struct {
	access map[string]authz.RepoAccess
	err    error
	checks []repoCheck
}

type repoCheck struct{ Token, Repo string }

func (f *fakeRepos) CanRead(_ context.Context, token, owner, name string) (authz.RepoAccess, error) {
	f.checks = append(f.checks, repoCheck{token, owner + "/" + name})
	if f.err != nil {
		return 0, f.err
	}
	if a, ok := f.access[owner+"/"+name]; ok {
		return a, nil
	}
	return authz.RepoNotVisible, nil
}

func newGatedService(t *testing.T, repos *fakeRepos) (*authz.Service, *identitylink.Fake, *fakeSecrets) {
	t.Helper()
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	secrets := &fakeSecrets{}
	return authz.New(authz.Deps{
		Links: links, Secret: secrets, StartRetryDelay: time.Microsecond, Repos: repos,
	}), links, secrets
}

// The production agent's shape once it reads as the caller (ADR 0041).
var sweProviders = []string{"github", "claude"}

// A chat caller whose GitHub and Claude are both linked.
func linkedChatCaller(links *identitylink.Fake) authz.Identity {
	links.Set(identitylink.ProviderGitHub, "openwebui:1234", identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"})
	links.Set(identitylink.ProviderClaude, "github:imaustink", identitylink.Token{Value: claudeToken})
	return chatCaller()
}

// ── per-user callers: checked with their own token ─────────────────────────

func TestAChatCallerWhoCanReadTheRepositoryIsLaunchedIntoIt(t *testing.T) {
	repos := &fakeRepos{access: map[string]authz.RepoAccess{"bitovi/platform": authz.RepoReadable}}
	svc, links, secrets := newGatedService(t, repos)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
		Identity: linkedChatCaller(links), TargetRepository: "bitovi/platform",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)

	require.Equal(t, []repoCheck{{githubToken, "bitovi/platform"}}, repos.checks,
		"the read check must run on the CALLER's token, not a shared one")
	require.Equal(t, "bitovi/platform", secrets.written[authz.TargetRepositoryEnv],
		"the run must be told the repository that was checked, so its write token is scoped to the same one")
	require.Equal(t, githubToken, secrets.written["GITHUB_TOKEN"], "reads run as the caller")
}

// The requirement this exists for: if the user cannot read it, nothing
// launches. No Secret is written, so no run can be started from this verdict.
func TestAChatCallerWhoCannotReadTheRepositoryLaunchesNothing(t *testing.T) {
	repos := &fakeRepos{access: map[string]authz.RepoAccess{"bitovi/secret": authz.RepoNotVisible}}
	svc, links, secrets := newGatedService(t, repos)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
		Identity: linkedChatCaller(links), TargetRepository: "bitovi/secret",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, verdict.Kind)
	require.Contains(t, verdict.Message, "bitovi/secret")
	require.Empty(t, verdict.SecretName)
	require.Zero(t, secrets.calls, "a refused turn must not have credentials written for it")
}

// A 401 is a dead token, not an answer about the repository. Saying "you
// can't see it" would send the user looking in the wrong place.
func TestARejectedTokenIsReportedAsALinkProblemNotADenial(t *testing.T) {
	repos := &fakeRepos{access: map[string]authz.RepoAccess{"bitovi/platform": authz.RepoTokenRejected}}
	svc, links, secrets := newGatedService(t, repos)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "a", IdentityProviders: sweProviders,
		Identity: linkedChatCaller(links), TargetRepository: "bitovi/platform",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, verdict.Kind)
	require.Contains(t, verdict.Message, "re-link")
	require.NotContains(t, verdict.Message, "can't see")
	require.Zero(t, secrets.calls)
}

// A check that got no answer must not become a launch.
func TestAReadCheckThatErrorsIsAnErrorNotALaunch(t *testing.T) {
	repos := &fakeRepos{err: errors.New("GitHub answered 502")}
	svc, links, secrets := newGatedService(t, repos)

	_, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "a", IdentityProviders: sweProviders,
		Identity: linkedChatCaller(links), TargetRepository: "bitovi/platform",
	})
	require.Error(t, err)
	require.Zero(t, secrets.calls)
}

func TestNoRepositoryAsksWhichOneInsteadOfLaunching(t *testing.T) {
	repos := &fakeRepos{}
	svc, links, secrets := newGatedService(t, repos)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders, Identity: linkedChatCaller(links),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, verdict.Kind)
	require.Contains(t, verdict.Message, "Which GitHub repository")
	require.Empty(t, repos.checks)
	require.Zero(t, secrets.calls)
}

// The repository name is interpolated into a GitHub URL, and for chat it
// came from a model. Anything that is not an owner/name pair stops here.
func TestAMalformedRepositoryIsRefusedBeforeAnyRequest(t *testing.T) {
	for _, repo := range []string{"../../orgs/bitovi", "bitovi", "bitovi/platform/tree/main", "bitovi/..", "bit ovi/x", "a/b?x=1"} {
		repos := &fakeRepos{}
		svc, links, _ := newGatedService(t, repos)
		verdict, err := svc.Authorize(context.Background(), authz.Request{
			AgentID: "a", IdentityProviders: sweProviders, Identity: linkedChatCaller(links), TargetRepository: repo,
		})
		require.NoError(t, err, repo)
		require.Equal(t, authz.KindRefused, verdict.Kind, repo)
		require.Empty(t, repos.checks, repo)
	}
}

// ── shared-subject callers (webhook relays) ────────────────────────────────

// A webhook turn's subject is shared by every sender, so it must never look
// up, start, or be handed a github token: the first person to link under it
// would become every sender's read identity. The sender's permission on the
// event repository was already checked by the adapter.
func TestAWebhookTurnNeverTouchesAGithubTokenAndIsScopedToTheEventRepository(t *testing.T) {
	repos := &fakeRepos{}
	svc, links, secrets := newGatedService(t, repos)
	links.Set(identitylink.ProviderClaude, "github:alice", identitylink.Token{Value: claudeToken})
	// A token sitting under the shared subject is exactly what must NOT be used.
	links.Set(identitylink.ProviderGitHub, "oidc:integration-gateway", identitylink.Token{Value: "gho_SOMEONE_ELSES", GitHubLogin: "mallory"})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
		Identity: webhookCaller(), SenderLogin: "alice", TargetRepository: "bitovi/platform",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Empty(t, links.Started, "no github link may be started under a shared subject")
	require.NotContains(t, secrets.written, "GITHUB_TOKEN", "a shared subject's github token must never reach a run")
	require.Equal(t, "bitovi/platform", secrets.written[authz.TargetRepositoryEnv])
	require.Empty(t, repos.checks, "the sender was verified by the adapter; there is no user token to check with")
}

// The incident shape: a chat turn that lost its per-user identity arrives as
// the shared subject with no sender. Nobody's access could have been checked.
func TestASharedSubjectWithNoVerifiedSenderIsRefused(t *testing.T) {
	svc, links, secrets := newGatedService(t, &fakeRepos{})
	links.Set(identitylink.ProviderClaude, "oidc:integration-gateway", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
		Identity: webhookCaller(), TargetRepository: "bitovi/platform",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, verdict.Kind)
	require.Contains(t, verdict.Message, "couldn't verify who is asking")
	require.Zero(t, secrets.calls)
}

// ── agents that do not act on GitHub ───────────────────────────────────────

func TestAnAgentThatDoesNotDeclareGithubIsNotGated(t *testing.T) {
	repos := &fakeRepos{}
	svc, links, secrets := newGatedService(t, repos)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "a", IdentityProviders: []string{"claude"}, Identity: linkedChatCaller(links),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Empty(t, repos.checks)
	require.NotContains(t, secrets.written, authz.TargetRepositoryEnv)
}

// ── the parts ──────────────────────────────────────────────────────────────

func TestParseRepository(t *testing.T) {
	owner, name, ok := authz.ParseRepository(" bitovi/bitovi-platform-services ")
	require.True(t, ok)
	require.Equal(t, "bitovi", owner)
	require.Equal(t, "bitovi-platform-services", name)

	for _, bad := range []string{"", "bitovi", "/x", "x/", "a/b/c", "a/..", "a/b c", "a/b#c"} {
		_, _, ok := authz.ParseRepository(bad)
		require.False(t, ok, bad)
	}
}

func TestGitHubRepoReaderMapsGitHubsAnswers(t *testing.T) {
	var gotAuth, gotPath string
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth, gotPath = r.Header.Get("Authorization"), r.URL.Path
		w.WriteHeader(status)
	}))
	defer srv.Close()
	reader := authz.GitHubRepoReader{APIURL: srv.URL}

	cases := map[int]authz.RepoAccess{
		http.StatusOK:           authz.RepoReadable,
		http.StatusNotFound:     authz.RepoNotVisible,
		http.StatusForbidden:    authz.RepoNotVisible,
		http.StatusUnauthorized: authz.RepoTokenRejected,
	}
	for code, want := range cases {
		status = code
		got, err := reader.CanRead(context.Background(), "gho_user", "bitovi", "platform")
		require.NoError(t, err, code)
		require.Equal(t, want, got, code)
	}
	require.Equal(t, "Bearer gho_user", gotAuth)
	require.Equal(t, "/repos/bitovi/platform", gotPath)

	status = http.StatusBadGateway
	_, err := reader.CanRead(context.Background(), "gho_user", "bitovi", "platform")
	require.Error(t, err, "a 5xx is not an answer about access")
}
