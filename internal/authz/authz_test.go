package authz_test

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/authz"
	"durable-agents/internal/identitylink"
)

// fakeSecrets records what would be written to a Kubernetes Secret. It hands
// back a name and keeps the values to itself — the same shape the real writer
// has, and the reason a credential cannot travel back through a Verdict.
type fakeSecrets struct {
	written map[string]string
	name    string
	err     error
	calls   int
}

func (f *fakeSecrets) WriteRunCredentials(_ context.Context, runID string, data map[string]string) (string, error) {
	f.calls++
	if f.err != nil {
		return "", f.err
	}
	f.written = data
	f.name = "run-creds-" + strings.NewReplacer(":", "-", "/", "-").Replace(runID)
	return f.name, nil
}

const (
	claudeToken = "sk-ant-oat-SUPERSECRET"
	githubToken = "gho_ALSOSECRET"
)

func newService(t *testing.T, wait time.Duration) (*authz.Service, *identitylink.Fake, *fakeSecrets) {
	t.Helper()
	links, err := identitylink.NewFake("", "")
	require.NoError(t, err)
	secrets := &fakeSecrets{}
	return authz.New(authz.Deps{
		Links: links, Secret: secrets, WaitForLink: wait,
		StartRetryDelay: time.Microsecond,
	}), links, secrets
}

func chatCaller() authz.Identity {
	// Open WebUI's forwarded-user JWT is the resolver that structurally knows
	// a subject is one human, so it is the one that asserts PerUser.
	return authz.Identity{Subject: "openwebui:1234", Roles: []string{"dev"}, PerUser: true}
}

func webhookCaller() authz.Identity {
	// integration-gateway authenticates as its own service account, so this
	// subject is SHARED by every sender. No PerUser.
	return authz.Identity{Subject: "oidc:integration-gateway", Roles: []string{"agent"}}
}

// ── the credential boundary ────────────────────────────────────────────────

// The property the package exists to hold. Upstream keeps credentials out of
// graph state; here they must additionally stay out of Temporal event history,
// which is durable and in the clear. A Verdict is an activity RESULT, so it is
// exactly what would be written there.
func TestNoCredentialMaterialEverLeavesInAVerdict(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	links.Set(identitylink.ProviderClaude, "github:imaustink", identitylink.Token{Value: claudeToken})
	links.Set(identitylink.ProviderGitHub, "openwebui:1234", identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"github", "claude"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)

	// Serialized the way Temporal would serialize it.
	encoded, err := json.Marshal(verdict)
	require.NoError(t, err)
	for _, secret := range []string{claudeToken, githubToken} {
		require.NotContains(t, string(encoded), secret,
			"a credential value must never appear in an activity result — it would be written to event history")
	}

	// The names DO travel, because a launcher needs them and they are not
	// secret.
	require.Equal(t, []string{"AGENT_ACTOR_LOGIN", "CLAUDE_CODE_OAUTH_TOKEN", "GITHUB_TOKEN"}, verdict.EnvVarNames)
	require.NotEmpty(t, verdict.SecretName)

	// And the values reached the Secret, keyed by the env var names.
	require.Equal(t, claudeToken, secrets.written["CLAUDE_CODE_OAUTH_TOKEN"])
	require.Equal(t, githubToken, secrets.written["GITHUB_TOKEN"])
}

// A launch must never proceed believing it holds credentials it does not.
func TestSecretWriteFailureIsAnErrorNotAVerdict(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	secrets.err = errors.New("apiserver unavailable")
	links.Set(identitylink.ProviderGitHub, "openwebui:1234", identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"})

	_, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"github"},
		Identity:          chatCaller(),
	})
	require.ErrorContains(t, err, "persist run credentials")
}

// ── batch pre-flight (ADR 0030 §4) ─────────────────────────────────────────

// Nothing short-circuits: every gap is found and offered on ONE turn, so a
// human authorizes once instead of discovering the next gap per trigger.
func TestEveryMissingProviderIsReportedTogether(t *testing.T) {
	svc, _, _ := newService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"github", "claude-remote"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink", // already has a principal
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Contains(t, verdict.Message, "GitHub")
	require.Contains(t, verdict.Message, "Claude (Remote Control)")
	require.NotNil(t, verdict.Pending)
}

// Provider order must not be load-bearing: upstream's short-circuit meant a
// GitHub outage blocked Claude authorization entirely.
func TestAFailedStartIsReportedAlongsideTheOthersNotInsteadOfThem(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.StartErr["github"] = errors.New("github oauth is down")

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"github", "claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Contains(t, verdict.Message, "Claude", "the reachable provider's link is still offered")
	require.Contains(t, verdict.Message, "couldn't start")
	require.Contains(t, verdict.Message, "GitHub")
}

// One retry turns the common transient failure into a single-turn success,
// rather than a second authorization round for a near-identically-labelled
// credential — which reads to a user as an auth loop.
func TestStartIsRetriedOnce(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.StartErr["claude"] = errors.New("PTY start timed out")

	_, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
	})
	require.NoError(t, err)
	require.Len(t, links.Started, 0, "both attempts failed, so nothing was recorded as started")

	links.StartErr = map[string]error{}
	_, err = svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
	})
	require.NoError(t, err)
	require.Len(t, links.Started, 1)
}

// ── principals (ADR 0031) ──────────────────────────────────────────────────

// The security core. A shared subject must never have a login filed under it:
// every later senderLogin-less webhook turn would inherit that one person's
// credentials.
func TestASharedSubjectNeverEstablishesAPrincipal(t *testing.T) {
	svc, links, _ := newService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(), // PerUser is false
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)

	for _, s := range links.Started {
		require.NotEqual(t, authz.PrincipalProvider, s.Provider,
			"a principal-establishing link must never be offered to a shared subject")
	}
	require.Equal(t, "oidc:integration-gateway", verdict.Pending.Subject,
		"the credential stays keyed by the raw shared subject")
}

// A webhook turn's verified sender IS the proof a canonical principal needs.
func TestAVerifiedSenderLoginIsTheCanonicalPrincipal(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.Set(identitylink.ProviderClaude, "github:imaustink", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, "github:imaustink", verdict.Principal)
	require.Equal(t, "imaustink", verdict.ActorLogin)
}

// GitHub echoes logins with inconsistent casing across the webhook payload and
// the OAuth user API. Two casings keying two records is the re-prompt loop
// principals exist to prevent.
func TestPrincipalIsCaseNormalized(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.Set(identitylink.ProviderClaude, "github:imaustink", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "ImAustink",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind, "the differently-cased login must resolve the same record")
	require.Equal(t, "github:imaustink", verdict.Principal)
}

// A chat caller with no principal yet gets the mapping established FIRST, and
// that step is link-only: it contributes a login and no credential, so no
// GITHUB_TOKEN reaches the run. Conflating the two is what produced upstream's
// 401.
func TestPrincipalStepIsLinkOnlyAndRunsFirst(t *testing.T) {
	svc, links, secrets := newService(t, time.Minute)
	// The user completes the github link during the wait.
	links.CompleteOnWait["github"] = identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"}
	links.Set(identitylink.ProviderClaude, "github:imaustink", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude"}, // github is NOT declared
		Identity:          chatCaller(),
		// A live turn can show the prompt now, so waiting for the human to
		// finish is useful rather than merely hiding it.
		WaitForLink: true,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, "github:imaustink", verdict.Principal)

	require.NotContains(t, secrets.written, "GITHUB_TOKEN",
		"the principal step contributes a mapping and nothing else")
	require.Equal(t, claudeToken, secrets.written["CLAUDE_CODE_OAUTH_TOKEN"])
	require.Equal(t, "imaustink", verdict.ActorLogin)
}

// A pending PRINCIPAL stops the turn there: the remaining providers would have
// to be keyed by a subject the caller is one link away from abandoning, which
// would file the credentials they are about to create under the raw subject —
// re-creating the split principals exist to close.
func TestAPendingPrincipalStopsTheTurnBeforeOtherProviders(t *testing.T) {
	svc, links, _ := newService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude", "claude-remote"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Equal(t, authz.PrincipalProvider, verdict.Pending.Provider)
	require.Len(t, links.Started, 1, "no other provider's flow may start under a doomed subject")
	require.Equal(t, "github", links.Started[0].Provider)
}

// Sharing is an improvement, not a precondition: a GitHub hiccup must not deny
// a run whose own credentials are already linked.
func TestAPrincipalLinkThatWontStartDegradesRatherThanBlocking(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.StartErr["github"] = errors.New("github oauth is down")
	// The caller's claude credential is already at their RAW subject.
	links.Set(identitylink.ProviderClaude, "openwebui:1234", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind,
		"the run proceeds on the raw subject, without cross-entry-point sharing")
	require.Equal(t, "openwebui:1234", verdict.Principal)
}

// A lookup that ERRORS is not an answer of "no link". Treating it as one put a
// one-time-setup prompt in front of callers who had linked months earlier — on
// every single turn, while the turn then succeeded anyway.
func TestALookupErrorDoesNotOfferALinkThatMayExist(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.LinkedLoginErr["github"] = errors.New("gateway blip")
	links.Set(identitylink.ProviderClaude, "openwebui:1234", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	for _, s := range links.Started {
		require.NotEqual(t, "github", s.Provider, "a blip costs sharing, not a spurious prompt")
	}
}

// Never prompt for a link that already exists.
func TestAnExistingGithubLinkEstablishesThePrincipalWithoutPrompting(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.Set(identitylink.ProviderGitHub, "openwebui:1234", identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"})
	links.Set(identitylink.ProviderClaude, "github:imaustink", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, "github:imaustink", verdict.Principal)
	require.Empty(t, links.Started, "nothing needed starting")
}

// ── adoption (ADR 0031) ────────────────────────────────────────────────────

// A caller who authorized before principals existed must not be charged a
// fresh login to reproduce a credential the gateway is still holding.
func TestAPrePrincipalCredentialIsAdoptedNotReAuthorized(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	links.Set(identitylink.ProviderGitHub, "openwebui:1234", identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"})
	// The claude credential is at the OLD key.
	links.Set(identitylink.ProviderClaude, "openwebui:1234", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Empty(t, links.Started, "no re-authorization")
	require.Equal(t, []rekeyExpectation{{"claude", "openwebui:1234", "github:imaustink"}}, rekeys(links))
	require.Equal(t, claudeToken, secrets.written["CLAUDE_CODE_OAUTH_TOKEN"])
}

// The webhook path's subject is shared, so adopting from it would hand
// whoever authorized first their credential to the current sender outright.
func TestASharedSubjectNeverAdopts(t *testing.T) {
	svc, links, _ := newService(t, 0)
	links.Set(identitylink.ProviderClaude, "oidc:integration-gateway", identitylink.Token{Value: claudeToken})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "someone-else",
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind,
		"the sender is asked to authorize, not handed the shared subject's credential")
	require.Empty(t, rekeys(links))
}

// ── misconfiguration ───────────────────────────────────────────────────────

// No amount of user action fixes a provider the deployment cannot serve, so it
// must not be reported as a link the caller should complete.
func TestAnUnsupportedProviderIsMisconfiguredNotLinkRequired(t *testing.T) {
	svc, _, _ := newService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "a",
		IdentityProviders: []string{"gitlab"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindMisconfigured, verdict.Kind)
	require.Contains(t, verdict.Error, "gitlab")
}

func TestNoProvidersIsImmediatelyAuthorized(t *testing.T) {
	svc, _, secrets := newService(t, 0)

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:  "web-search-agent",
		Identity: chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Empty(t, verdict.SecretName)
	require.Zero(t, secrets.calls, "no credentials means no Secret to write")
}

// ── the read-only entry point ──────────────────────────────────────────────

// A paused TOOL call has no resume slot, so this path must never start a link
// flow. It exists so the tool path shares the agent path's keying rules rather
// than hand-copying them.
func TestResolveLinkedNeverStartsALinkFlow(t *testing.T) {
	svc, links, _ := newService(t, time.Minute)

	verdict, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID:           "github-tool",
		IdentityProviders: []string{"github"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind)
	require.Empty(t, links.Started, "a paused tool call has nowhere to resume from")
	require.Nil(t, verdict.Pending, "and therefore no resume anchor")
	require.Contains(t, verdict.Message, "GitHub")
}

func TestResolveLinkedAuthorizesWhenEverythingIsPresent(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	links.Set(identitylink.ProviderGitHub, "openwebui:1234", identitylink.Token{Value: githubToken, GitHubLogin: "imaustink"})

	verdict, err := svc.ResolveLinked(context.Background(), authz.Request{
		AgentID:           "github-tool",
		IdentityProviders: []string{"github"},
		Identity:          chatCaller(),
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Equal(t, []string{"GITHUB_TOKEN"}, verdict.EnvVarNames)
	require.Equal(t, githubToken, secrets.written["GITHUB_TOKEN"])

	encoded, err := json.Marshal(verdict)
	require.NoError(t, err)
	require.NotContains(t, string(encoded), githubToken)
}

// ── write-back (ADR 0034) ──────────────────────────────────────────────────

// A claude-remote credential is refreshed in place by the run's own CLI, and
// Anthropic rotates the refresh token when it does — so without write-back the
// resolved copy dies on first refresh and every later run reports "Login
// expired".
func TestClaudeRemoteCarriesAWritebackGrantOwnedByTheRun(t *testing.T) {
	svc, links, secrets := newService(t, 0)
	links.Set(identitylink.ProviderClaudeRemote, "github:imaustink", identitylink.Token{Value: "{\"claudeAiOauth\":{}}"})

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude-remote"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
		RunTimeoutSeconds: 1800,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindAuthorized, verdict.Kind)
	require.Contains(t, secrets.written, authz.WritebackURLEnv)
	require.Contains(t, secrets.written, authz.WritebackTokenEnv)
	require.NotEmpty(t, verdict.OwnedSecretNames,
		"the grant joins the run's ownership so Kubernetes reclaims it rather than one accumulating per launch")
}

// helpers

type rekeyExpectation struct{ Provider, From, To string }

func rekeys(f *identitylink.Fake) []rekeyExpectation {
	out := make([]rekeyExpectation, 0, len(f.Rekeyed))
	for _, r := range f.Rekeyed {
		out = append(out, rekeyExpectation{r.Provider, r.From, r.To})
	}
	return out
}

// A fire-and-forget caller must not wait. The link reaches such a user only in
// the turn's final result, so waiting would hide the prompt for the entire
// window — and nobody completes a link they cannot see, so the wait could only
// ever time out.
func TestAFireAndForgetTurnNeverWaitsForALink(t *testing.T) {
	svc, links, _ := newService(t, time.Minute)
	// If it waited, this would resolve and the turn would authorize.
	links.CompleteOnWait["claude"] = identitylink.Token{Value: claudeToken}

	verdict, err := svc.Authorize(context.Background(), authz.Request{
		AgentID:           "claude-code-swe-agent",
		IdentityProviders: []string{"claude"},
		Identity:          webhookCaller(),
		SenderLogin:       "imaustink",
		WaitForLink:       false,
	})
	require.NoError(t, err)
	require.Equal(t, authz.KindLinkRequired, verdict.Kind,
		"the prompt must reach the user now, in this turn's result")
	require.NotNil(t, verdict.Pending, "and leave an anchor so the next trigger resumes")
}
