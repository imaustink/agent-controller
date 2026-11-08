package authz_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/authz"
)

// A read-only run (ADR 0048) gets no write-capable credential from this
// package: the caller's GitHub token is withheld from the run's Secret, while
// the read gate still checks the caller's own access with it first. The
// writable case alongside is what proves the assertion can fail.
func TestAReadOnlyRunIsLaunchedWithoutTheCallersGitHubToken(t *testing.T) {
	for _, readOnly := range []bool{false, true} {
		repos := &fakeRepos{access: map[string]authz.RepoAccess{"bitovi/platform": authz.RepoReadable}}
		svc, links, secrets := newGatedService(t, repos)

		verdict, err := svc.Authorize(context.Background(), authz.Request{
			AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
			Identity: linkedChatCaller(links), TargetRepository: "bitovi/platform",
			ReadOnly: readOnly,
		})
		require.NoError(t, err)
		require.Equal(t, authz.KindAuthorized, verdict.Kind)
		require.Equal(t, []repoCheck{{githubToken, "bitovi/platform"}}, repos.checks,
			"the read gate runs on the caller's token either way")
		require.Equal(t, claudeToken, secrets.written["CLAUDE_CODE_OAUTH_TOKEN"], "model credentials are not write credentials")
		require.Equal(t, "bitovi/platform", secrets.written[authz.TargetRepositoryEnv])

		if readOnly {
			require.NotContains(t, secrets.written, "GITHUB_TOKEN", "readOnly=%t", readOnly)
			require.NotContains(t, verdict.EnvVarNames, "GITHUB_TOKEN")
		} else {
			require.Equal(t, githubToken, secrets.written["GITHUB_TOKEN"], "readOnly=%t", readOnly)
		}
	}
}

// A TOOL declaring github is refused outright in a read-only turn rather than
// launched without its token: a tool Job's template may carry a static
// GITHUB_TOKEN that the per-run entry would otherwise have overridden.
func TestAReadOnlyTurnRefusesAToolThatActsOnGitHub(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	caller := linkedChatCaller(links)

	verdict, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "gh-commenter", IdentityProviders: []string{"github"}, Identity: caller, ReadOnly: true,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindRefused, verdict.Kind)
	require.NotEmpty(t, verdict.Message)
	require.Zero(t, secrets.calls, "nothing is written for a refused tool")

	verdict, err = svc.ResolveLinked(context.Background(), authz.Request{
		AgentID: "gh-commenter", IdentityProviders: []string{"github"}, Identity: caller,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind, "the same tool runs in an ordinary turn")
}
