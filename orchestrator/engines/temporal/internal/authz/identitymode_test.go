package authz_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/aktisai/orchestrator/engines/temporal/internal/authz"
	"github.com/aktisai/orchestrator/engines/temporal/internal/identitylink"
)

// ── ResolveMode ────────────────────────────────────────────────────────────

func TestResolveModePrecedenceAndValidation(t *testing.T) {
	gh := []string{"github", "claude"}
	cases := []struct {
		name               string
		override, def      string
		allowed, providers []string
		want               authz.IdentityMode
		source             authz.ModeSource
		errContains        string
	}{
		{name: "inferred hybrid when github is declared", providers: gh, want: authz.ModeHybrid, source: authz.SourceInferred},
		{name: "inferred agent otherwise", providers: []string{"claude"}, want: authz.ModeAgent, source: authz.SourceInferred},
		{name: "inferred agent with no providers", want: authz.ModeAgent, source: authz.SourceInferred},
		{name: "the agent's default beats inference", def: "agent", providers: gh, want: authz.ModeAgent, source: authz.SourceDefault},
		{name: "the trigger's override beats the default", override: "delegated", def: "agent", providers: gh, want: authz.ModeDelegated, source: authz.SourceTrigger},
		{name: "an override inside allowedIdentities", override: "agent", def: "hybrid", allowed: []string{"hybrid", "agent"}, providers: gh, want: authz.ModeAgent, source: authz.SourceTrigger},
		{name: "an override outside allowedIdentities", override: "agent", def: "delegated", allowed: []string{"delegated"}, providers: gh, errContains: "allowedIdentities"},
		{name: "a default outside allowedIdentities", def: "hybrid", allowed: []string{"agent"}, providers: gh, errContains: "allowedIdentities"},
		{name: "inference is not held to allowedIdentities", allowed: []string{"agent"}, providers: gh, want: authz.ModeHybrid, source: authz.SourceInferred},
		{name: "an unknown override", override: "user", providers: gh, errContains: "not one of"},
		{name: "an unknown default", def: "service", providers: gh, errContains: "not one of"},
		{name: "delegated with only runtime providers", def: "delegated", providers: []string{"claude"}, errContains: "resource identity provider"},
		{name: "hybrid with no providers", def: "hybrid", errContains: "resource identity provider"},
		{name: "agent needs no resource provider", def: "agent", want: authz.ModeAgent, source: authz.SourceDefault},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d, err := authz.ResolveMode(tc.override, tc.def, tc.allowed, tc.providers)
			if tc.errContains != "" {
				require.Error(t, err)
				require.Contains(t, err.Error(), tc.errContains)
				return
			}
			require.NoError(t, err)
			require.Equal(t, tc.want, d.Requested)
			require.Equal(t, tc.source, d.Source)
		})
	}
}

// ── agent mode ─────────────────────────────────────────────────────────────

// A chat caller who never linked GitHub launches an agent-mode agent: it acts
// as the App, so their GitHub account is neither needed nor checked. The same
// caller and agent in hybrid mode is asked to link, which is what proves the
// agent-mode assertion can fail.
func TestAgentModeNeedsNoGitHubLinkFromChat(t *testing.T) {
	for _, mode := range []string{"agent", "hybrid"} {
		repos := &fakeRepos{access: map[string]authz.RepoAccess{readableRepo: authz.RepoReadable}}
		svc, links, secrets := newGatedService(t, repos)
		links.Set(identitylink.ProviderClaude, "openwebui:1234", identitylink.Token{Value: claudeToken})

		verdict, err := svc.Authorize(context.Background(), authz.Request{
			AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
			Identity: chatCaller(), TargetRepository: readableRepo,
			DefaultIdentity: mode,
		})
		require.NoError(t, err)
		require.Equal(t, authz.IdentityMode(mode), verdict.RequestedIdentityMode)
		require.Equal(t, authz.SourceDefault, verdict.IdentityModeSource)

		if mode == "hybrid" {
			require.Equal(t, authz.KindLinkRequired, verdict.Kind, "hybrid reads as the caller, so it needs their GitHub link")
			continue
		}
		require.Equal(t, authz.KindAuthorized, verdict.Kind)
		require.Equal(t, authz.ModeAgent, verdict.IdentityMode)
		require.NotContains(t, secrets.written, "GITHUB_TOKEN", "agent mode resolves no caller token")
		require.Equal(t, claudeToken, secrets.written["CLAUDE_CODE_OAUTH_TOKEN"], "runtime providers resolve in every mode")
		require.Equal(t, readableRepo, secrets.written[authz.TargetRepositoryEnv], "a named repository still scopes the App token")
		require.Empty(t, repos.checks, "nobody's access is checked in agent mode")
		require.Equal(t, []authz.LaunchCredential{
			{Provider: "github", Read: "agent", Write: "agent"},
			{Provider: "claude", Read: "caller"},
		}, verdict.Credentials)
	}
}

// An explicit agent-mode agent runs from a cron tick (a shared subject with
// no sender): the operator said it acts as itself. The pre-0049 inferred
// behaviour for the same agent still refuses, because nobody vouched for a
// sender and the run would otherwise have read as one.
func TestExplicitAgentModeRunsWithoutASender(t *testing.T) {
	for _, def := range []string{"agent", ""} {
		svc, _, _ := newService(t, 0)
		verdict, err := svc.Authorize(context.Background(), authz.Request{
			AgentID: "claude-code-swe-agent", IdentityProviders: []string{"github"},
			Identity: webhookCaller(), TargetRepository: readableRepo,
			DefaultIdentity: def,
		})
		require.NoError(t, err)
		if def == "agent" {
			require.Equal(t, authz.KindAuthorized, verdict.Kind)
			require.Equal(t, authz.ModeAgent, verdict.IdentityMode)
			continue
		}
		require.Equal(t, authz.KindRefused, verdict.Kind, "inferred: unchanged pre-0049 refusal")
		require.Contains(t, verdict.Message, "couldn't verify who is asking")
	}
}

// ── caller-using modes from a shared subject ───────────────────────────────

// A webhook relay is no one person. An EXPLICIT hybrid/delegated agent asked
// to act as the person who asked, so it is refused rather than quietly run as
// the App. The inferred mode keeps its pre-0049 behaviour: run as the agent,
// gated on the vouched-for sender.
func TestCallerModesFromASharedSubject(t *testing.T) {
	for _, def := range []string{"hybrid", "delegated", ""} {
		svc, _, secrets := newService(t, 0)
		verdict, err := svc.Authorize(context.Background(), authz.Request{
			AgentID: "claude-code-swe-agent", IdentityProviders: []string{"github"},
			Identity: webhookCaller(), SenderLogin: "alice", TargetRepository: readableRepo,
			DefaultIdentity: def,
		})
		require.NoError(t, err, "defaultIdentity=%q", def)
		if def != "" {
			require.Equal(t, authz.KindRefused, verdict.Kind, "defaultIdentity=%q", def)
			// The sender resolved to no subject (this source extracts no
			// account id), which linking cannot fix: reported as such.
			require.NotNil(t, verdict.IdentityError)
			require.Equal(t, authz.CodeIdentityUnavailable, verdict.IdentityError.Code)
			require.Equal(t, verdict.IdentityError.Message, verdict.Message)
			require.Zero(t, secrets.calls)
			continue
		}
		require.Equal(t, authz.KindAuthorized, verdict.Kind)
		require.Equal(t, authz.ModeHybrid, verdict.RequestedIdentityMode)
		require.Equal(t, authz.SourceInferred, verdict.IdentityModeSource)
		require.Equal(t, authz.ModeAgent, verdict.IdentityMode, "a shared subject's run reads with the App token, as before")
		require.NotContains(t, secrets.written, "GITHUB_TOKEN")
	}
}

// ── delegated ──────────────────────────────────────────────────────────────

func TestDelegatedModeHandsTheRunTheCallersTokenForEverything(t *testing.T) {
	repos := &fakeRepos{access: map[string]authz.RepoAccess{readableRepo: authz.RepoReadable}}
	svc, links, secrets := newGatedService(t, repos)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
		Identity: linkedChatCaller(links), TargetRepository: readableRepo,
		DefaultIdentity: "delegated",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, authz.ModeDelegated, verdict.IdentityMode)
	require.Equal(t, githubToken, secrets.written["GITHUB_TOKEN"])
	require.Equal(t, []repoCheck{{githubToken, readableRepo}}, repos.checks, "the read gate runs on the caller's token")
	require.Equal(t, authz.LaunchCredential{Provider: "github", Read: "caller", Write: "caller"}, verdict.Credentials[0])
}

// ── read-only narrows the run mode ─────────────────────────────────────────

// A read-only hybrid run has its caller token withheld, so it reads with the
// agent's read-only credential: the run mode it is told must say "agent", or
// it would go looking for a token it does not have. The requested mode keeps
// what was asked for, for the audit record.
func TestReadOnlyNarrowsACallerModeToAgent(t *testing.T) {
	for _, readOnly := range []bool{false, true} {
		repos := &fakeRepos{access: map[string]authz.RepoAccess{readableRepo: authz.RepoReadable}}
		svc, links, _ := newGatedService(t, repos)

		verdict, err := svc.Authorize(context.Background(), authz.Request{
			AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
			Identity: linkedChatCaller(links), TargetRepository: readableRepo,
			DefaultIdentity: "hybrid", ReadOnly: readOnly,
		})
		require.NoError(t, err)
		require.Equal(t, authz.KindAuthorized, verdict.Kind)
		require.Equal(t, authz.ModeHybrid, verdict.RequestedIdentityMode)
		if readOnly {
			require.Equal(t, authz.ModeAgent, verdict.IdentityMode)
			require.Equal(t, authz.LaunchCredential{Provider: "github", Read: "agent", Write: "none"}, verdict.Credentials[0])
		} else {
			require.Equal(t, authz.ModeHybrid, verdict.IdentityMode)
			require.Equal(t, authz.LaunchCredential{Provider: "github", Read: "caller", Write: "agent"}, verdict.Credentials[0])
		}
	}
}

// ── misconfiguration ───────────────────────────────────────────────────────

func TestAnOverrideOutsideAllowedIdentitiesIsMisconfigured(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "claude-code-swe-agent", IdentityProviders: sweProviders,
		Identity: linkedChatCaller(links), TargetRepository: readableRepo,
		DefaultIdentity: "delegated", AllowedIdentities: []string{"delegated"},
		IdentityOverride: "agent",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindMisconfigured, verdict.Kind)
	require.Contains(t, verdict.Error, "allowedIdentities")
	require.Equal(t, authz.SourceTrigger, verdict.IdentityModeSource)
	require.Zero(t, secrets.calls)
}

func TestAnUnsupportedProviderIsMisconfiguredInAgentModeToo(t *testing.T) {
	svc, _, _ := newService(t, 0)
	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID: "a", IdentityProviders: []string{"gitlab"}, Identity: chatCaller(),
		DefaultIdentity: "agent",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindMisconfigured, verdict.Kind)
	require.Contains(t, verdict.Error, "gitlab")
}
