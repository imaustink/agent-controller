// Package authz owns every authorization decision for an agent launch:
// which credentials a run requires, whether they are satisfied, what identity
// they resolve to, and what the run is therefore handed.
//
// # Why this is one owner
//
// Upstream ADR 0030's property is that authorization has a single owner and
// that owner is plain control flow — never something a planner can select,
// skip, or reorder. No model call participates in an authorization decision.
// That is a security boundary, not a style preference: an LLM that can decide
// whether authorization succeeded is an LLM that can be argued into saying
// yes.
//
// It is also why there is exactly one of these. Two copies of credential
// keying is the shape of upstream's PR #144 bug, and the reason its
// agent-backed-tool path calls a deliberately read-only entry point here
// rather than growing its own provider loop.
//
// # Credentials and Temporal
//
// Upstream keeps a resolved credential in a node-local variable so it never
// reaches graph state. Doing the equivalent here is not enough: an activity
// result that lands in workflow state is written to Temporal's event history,
// durably and in the clear, and stays there for the workflow's retention. That
// is strictly worse than upstream's property, not equal to it.
//
// So Authorize resolves credentials and writes them straight into a Kubernetes
// Secret, returning only that Secret's NAME and the env var names it carries.
// Nothing a workflow can see holds credential material. The launcher redeems
// the reference; the kubelet is the only thing that reads a value.
package authz

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sort"
	"strings"
	"time"

	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// CrossEntryPointProviders are keyed by PRINCIPAL rather than by the entry
// point's own subject: the ones a human authorizes by hand and expects to do
// once, whichever door they came in through.
var CrossEntryPointProviders = map[string]bool{
	identitylink.ProviderClaude:       true,
	identitylink.ProviderClaudeRemote: true,
}

// PrincipalProvider is the link that ESTABLISHES a principal — GitHub,
// because it is the one identity both entry points can reach: a webhook
// vouches for the sender, and a chat caller can prove control of the account.
//
// Nothing else about the pre-flight is GitHub-specific. When principals become
// first-class this is the constant that stops meaning "GitHub" and starts
// meaning "whatever establishes the alias".
const PrincipalProvider = identitylink.ProviderGitHub

// canonicalPrincipalPrefix marks a principal as resolved from a verified
// GitHub identity, as opposed to a raw entry-point subject standing in for
// itself. A prefix test is sound because every entry-point subject is either
// namespaced by its own resolver (openwebui:<id>) or an IdP `sub`, and none of
// them can be github:<login> — that namespace exists solely for principals.
const canonicalPrincipalPrefix = "github:"

// CanonicalPrincipal builds the principal for a GitHub login.
//
// Lower-cased because GitHub logins are case-insensitive for identity but are
// echoed with their original casing in webhook payloads and with a different
// one from the OAuth user API. Without normalizing, "Imaustink" from a webhook
// and "imaustink" from a link key two different records and re-prompt in
// exactly the way principals exist to prevent.
func CanonicalPrincipal(login string) string {
	return canonicalPrincipalPrefix + strings.ToLower(login)
}

// IsCanonicalPrincipal distinguishes the cross-entry-point principal from a
// raw subject standing in for itself.
func IsCanonicalPrincipal(principal string) bool {
	return strings.HasPrefix(principal, canonicalPrincipalPrefix)
}

// ProviderEnvVar maps a provider onto the env var its credential is injected
// as, and doubles as the set of providers this system supports at all.
var ProviderEnvVar = map[string]string{
	identitylink.ProviderGitHub:       "GITHUB_TOKEN",
	identitylink.ProviderClaude:       "CLAUDE_CODE_OAUTH_TOKEN",
	identitylink.ProviderClaudeRemote: "CLAUDE_LOGIN_CREDENTIALS_JSON",
}

// ActorLoginEnv carries the caller's resolved GitHub login into a run, so the
// agent performs no identity work of its own.
//
// This is the fix for upstream's production `401 Bad credentials`: the agent
// was calling GitHub's /user with its injected token to learn who it was
// acting as. With the login already present that call does not happen, so the
// failure is removed by construction rather than debugged.
const ActorLoginEnv = "AGENT_ACTOR_LOGIN"

// Writeback env vars let a run persist a credential its own CLI rotated.
const (
	WritebackURLEnv   = "CLAUDE_CREDENTIALS_WRITEBACK_URL"
	WritebackTokenEnv = "CLAUDE_CREDENTIALS_WRITEBACK_TOKEN"
)

// writebackGrantMargin outlives the run itself, so a credential refreshed in
// the run's final moments can still be persisted.
const writebackGrantMargin = 15 * time.Minute

// startAttempts is deliberately small, with no backoff growth.
//
// A start that fails silently turns ADR 0030 §4's "authorize once for
// everything" into two rounds: the user completes the link they were shown,
// the next turn re-assesses, the previously-failed flow starts fine, and they
// authorize a second time for a near-identically-labelled credential. That
// reads as an auth loop. One retry converts the common transient failure into
// a single-turn success; more would trade the turn a human is waiting on for a
// case the next trigger recovers anyway.
const startAttempts = 2

const startRetryDelay = time.Second

// Identity is the resolved caller.
type Identity struct {
	Subject string   `json:"subject"`
	Roles   []string `json:"roles,omitempty"`

	// Principal is the stable per-human key, when one is established.
	Principal string `json:"principal,omitempty"`

	// PerUser asserts that Subject identifies ONE human.
	//
	// The security core of ADR 0031, and it must be asserted by the resolver
	// that structurally knows — never inferred here from a proxy. A webhook
	// relay authenticates as the gateway's own service account, so its subject
	// is SHARED by every sender: filing a login under it would make every
	// later senderLogin-less webhook turn inherit that one person's Claude
	// credentials. Absent the assertion this degrades to no sharing, never to
	// the wrong principal.
	PerUser bool `json:"perUser,omitempty"`
}

// Request is everything the pre-flight depends on, named explicitly rather
// than handed whole workflow state — so it is evident that authorization turns
// on the caller's identity and the Agent's declarations, and on nothing a
// model produced.
type Request struct {
	AgentID           string   `json:"agentId"`
	IdentityProviders []string `json:"identityProviders,omitempty"`
	Identity          Identity `json:"identity"`

	// SenderLogin is the human an adapter vouched for, from a verified
	// assertion. Never caller-supplied text.
	SenderLogin string `json:"senderLogin,omitempty"`

	// Flow is "device" for a headless caller with no browser to redirect;
	// defaults to authcode.
	Flow string `json:"flow,omitempty"`

	// WaitForLink says this turn has a live channel, so the caller can see a
	// link prompt NOW and the pre-flight may wait for them to complete it.
	//
	// False for a fire-and-forget caller, and that is not a tuning choice: the
	// link reaches such a user only in the turn's final result, so waiting
	// would hide the link for the entire window. Nobody completes a link they
	// cannot see, so the wait could only ever time out.
	WaitForLink bool `json:"waitForLink,omitempty"`

	// RunTimeoutSeconds sizes a write-back grant's lifetime.
	RunTimeoutSeconds int32 `json:"runTimeoutSeconds,omitempty"`

	// Pending is the anchor from a turn that previously stopped on this exact
	// link, if this is a resume. Its purpose is narrow: let the provider loop
	// recognize a flow it already started so it can re-check that ONE flow
	// instead of starting a second one out from under a caller who is
	// mid-way through the first.
	Pending *PendingLink `json:"pending,omitempty"`
}

// Kind is the verdict's discriminator.
type Kind string

const (
	// KindAuthorized: cleared to launch.
	KindAuthorized Kind = "authorized"
	// KindLinkRequired: one or more links outstanding, or a flow that would
	// not start. Message is the complete user-facing text.
	KindLinkRequired Kind = "link-required"
	// KindMisconfigured: not cleared, and not the caller's fault. Distinct
	// from link-required because no amount of user action fixes it.
	KindMisconfigured Kind = "misconfigured"
)

// PendingLink is the resume anchor for a parked link.
type PendingLink struct {
	AgentID    string `json:"agentId"`
	Provider   string `json:"provider"`
	Flow       string `json:"flow"`
	DeviceCode string `json:"deviceCode,omitempty"`
	// Subject is the one Start was actually called with. Recomputing it on
	// resume instead is upstream's PR #144 re-auth loop.
	Subject   string `json:"subject"`
	ExpiresAt int64  `json:"expiresAt"` // unix millis
	// Request is captured so the resume re-delegates THIS goal, not whatever
	// text the turn that finally notices completion happens to carry.
	Request string `json:"request,omitempty"`
	// LinkText is the rendered prompt clause the caller was originally shown
	// ("[link your GitHub account](...) and enter code `ABCD-1234`"). Stored
	// so a resume that finds the flow still outstanding can repeat the EXACT
	// same prompt rather than re-deriving it from a fresh Start call, which
	// is what minted a second, different code for the same still-pending
	// flow.
	LinkText string `json:"linkText,omitempty"`
}

// Verdict is a TOTAL union: every case is an outcome the caller must handle.
// Adding a fourth breaks the switch rather than falling through to "launch
// anyway", which is the failure direction that matters.
type Verdict struct {
	Kind Kind `json:"kind"`

	// --- authorized ---

	// SecretName holds every credential this run receives. A NAME, never a
	// value: see the package doc on Temporal event history.
	SecretName string `json:"secretName,omitempty"`
	// EnvVarNames are the keys inside that Secret, and therefore the env vars
	// the run gets. Safe to log — names only.
	EnvVarNames []string `json:"envVarNames,omitempty"`
	ActorLogin  string   `json:"actorLogin,omitempty"`
	// Principal is the one credentials were actually keyed by, which the
	// pre-flight may have UPGRADED this turn. The caller must adopt it for the
	// rest of the turn: anything that later re-derives the key would otherwise
	// invalidate a record that was never written and leave the caller
	// re-reading a dead credential forever.
	Principal string `json:"principal,omitempty"`
	// OwnedSecretNames are objects created for THIS launch that the run should
	// own, so Kubernetes reclaims them with it rather than accumulating one
	// per launch forever.
	OwnedSecretNames []string `json:"ownedSecretNames,omitempty"`

	// --- link-required ---

	Message string       `json:"message,omitempty"`
	Pending *PendingLink `json:"pending,omitempty"`

	// --- misconfigured ---

	Error string `json:"error,omitempty"`
}

// SecretWriter persists a run's resolved credentials and returns the object's
// name. Implemented against Kubernetes Secrets; faked in tests.
//
// It takes the values and hands back a name precisely so that no credential
// crosses back out of this package.
type SecretWriter interface {
	WriteRunCredentials(ctx context.Context, runID string, data map[string]string) (string, error)
}

// Deps are the ports Authorize needs.
type Deps struct {
	Links  identitylink.Port
	Secret SecretWriter
	// WaitForLink bounds how long ONE gateway-side wait may block. Whether a
	// given turn waits at all is Request.WaitForLink; this is only the
	// ceiling, kept short so the workflow's durable timer stays in charge of
	// the overall wait rather than a held HTTP request.
	WaitForLink time.Duration

	// StartRetryDelay overrides the pause between link-start attempts. Zero
	// takes the default; tests set it to something negligible so the retry
	// path is exercised without the suite sleeping through it.
	StartRetryDelay time.Duration
}

// Service is the pre-flight. Constructed once from deps; unreachable from any
// model-selected code path.
type Service struct {
	deps Deps
}

func New(deps Deps) *Service { return &Service{deps: deps} }

var providerLabel = map[string]string{
	identitylink.ProviderGitHub:       "GitHub",
	identitylink.ProviderClaude:       "Claude",
	identitylink.ProviderClaudeRemote: "Claude Remote Control",
}

func label(provider string) string {
	if l := providerLabel[provider]; l != "" {
		return l
	}
	return provider
}

// providerStep is one entry in the assessment plan. principalOnly marks the
// link that contributes a MAPPING and nothing else — its token is never
// injected, which is what keeps obtaining an identity separable from
// provisioning a credential (the conflation behind upstream's 401).
type providerStep struct {
	name          string
	principalOnly bool
}

type pendingEntry struct {
	provider string
	linkText string
	pending  PendingLink
}

// Authorize is the single authorization decision point for a launch.
//
// It assesses EVERY declared provider before returning anything. Nothing
// short-circuits on the first gap (ADR 0030 §4): all missing links start on
// this one turn and are reported together, and a provider whose start failed
// is reported ALONGSIDE the others rather than instead of them. Previously the
// first gap ended the turn, which made CRD provider order load-bearing — a
// GitHub OAuth outage blocked Claude authorization entirely.
func (s *Service) Authorize(ctx context.Context, req Request) (Verdict, error) {
	if len(req.IdentityProviders) == 0 {
		return Verdict{Kind: KindAuthorized, Principal: s.principalOf(req)}, nil
	}
	if s.deps.Links == nil {
		return s.misconfigured(req, "", "no identity-link gateway is configured")
	}

	credentials := map[string]string{}
	var ownedSecretNames []string
	var pending []pendingEntry
	var failedToStart []string

	// actorLoginFromLoop is the caller's login read off their resolved github
	// link. Deliberately from the stored record rather than a /user call: the
	// login is already there, so this needs neither an API round trip nor
	// GitHub App credentials.
	var actorLoginFromLoop string

	plan, principal, principalLogin := s.planProviders(ctx, req, s.principalOf(req))

	for _, step := range plan {
		envVar, supported := ProviderEnvVar[step.name]
		if !supported {
			return s.misconfigured(req, step.name, fmt.Sprintf("unsupported identity provider %q", step.name))
		}

		// A cross-entry-point credential is keyed by principal; anything
		// scoped to this entry point by the raw subject. github stays on the
		// raw subject deliberately — a GitHub link is a property of the
		// specific account that established it, and it is the very thing
		// principal resolution reads, so keying it by principal is circular.
		credentialSubject := req.Identity.Subject
		if CrossEntryPointProviders[step.name] {
			credentialSubject = principal
		}

		token, err := s.deps.Links.Token(ctx, step.name, credentialSubject)
		if err != nil {
			log.Printf("[authorization] token lookup failed for %s@%s: %v", step.name, credentialSubject, err)
			token = nil
		}

		if token == nil {
			token = s.adopt(ctx, req, step.name, credentialSubject)
		}

		if token == nil {
			if anchor := s.matchingPending(req, step.name, credentialSubject); anchor != nil {
				// A flow is already outstanding for this exact
				// (provider, subject): re-check THAT ONE rather than
				// starting a second one. Starting again here is what turned
				// "send any message once you're done" into an endless
				// re-prompt — every resume raced a brand-new code against
				// whichever one the caller was still mid-way through
				// entering, and the caller could never win that race.
				var stillPending bool
				token, stillPending = s.recheckPending(ctx, req, step.name, credentialSubject, anchor)
				if token == nil && stillPending {
					pending = append(pending, pendingEntry{
						provider: step.name,
						linkText: anchor.LinkText,
						pending:  *anchor,
					})
					if step.principalOnly {
						break
					}
					continue
				}
				// token == nil && !stillPending: the anchor is dead (expired,
				// denied, or a poll error) — fall through to startLink below
				// and offer the caller a FRESH flow instead of silently
				// re-showing a code GitHub has already discarded.
			}
		}

		if token == nil {
			started, ok := s.startLink(ctx, step.name, credentialSubject, req.Flow)
			if !ok {
				// A principal link that will not start must DEGRADE, not
				// block: sharing is an improvement over per-entry-point
				// keying, and refusing the turn over it would let a GitHub
				// hiccup deny a run whose own credentials are already linked.
				if step.principalOnly {
					log.Printf("[authorization] could not start the principal-establishing %s link; "+
						"continuing on the raw subject, so this run's credentials will not be shared across entry points", PrincipalProvider)
					continue
				}
				failedToStart = append(failedToStart, label(step.name))
				continue
			}

			token = s.waitForLink(ctx, req, step.name, credentialSubject)
			if token == nil {
				linkText := linkPromptText(started, label(step.name))
				pending = append(pending, pendingEntry{
					provider: step.name,
					linkText: linkText,
					pending: PendingLink{
						AgentID:    req.AgentID,
						Provider:   step.name,
						Flow:       started.Flow,
						DeviceCode: started.DeviceCode,
						Subject:    credentialSubject,
						ExpiresAt:  time.Now().Add(time.Duration(started.ExpiresInSeconds) * time.Second).UnixMilli(),
						LinkText:   linkText,
					},
				})
				// Assess nothing further when it is the PRINCIPAL that is
				// pending: the remaining providers would have to be keyed by a
				// subject this turn is about to abandon, so starting their
				// flows would file the credentials the user is about to create
				// under the raw subject — re-creating the very split this
				// closes. The resume turn re-enters with a canonical principal
				// and assesses everything then. A deliberate exception to §4's
				// batching, because batching assumes the providers are
				// independent and these are not.
				if step.principalOnly {
					break
				}
				continue
			}
		}

		if step.principalOnly {
			// Link-only: it contributes the mapping and nothing else. No
			// credential entry, so no GITHUB_TOKEN reaches the run and the
			// agent's delegated-write path stays unreachable.
			if token.GitHubLogin != "" {
				principalLogin = token.GitHubLogin
				principal = CanonicalPrincipal(token.GitHubLogin)
			} else {
				log.Printf("[authorization] the %s link for this caller carries no login; "+
					"continuing on the raw subject, without cross-entry-point sharing", PrincipalProvider)
			}
			continue
		}

		if step.name == identitylink.ProviderGitHub && token.GitHubLogin != "" {
			actorLoginFromLoop = token.GitHubLogin
		}
		credentials[envVar] = token.Value

		if step.name == identitylink.ProviderClaudeRemote {
			if grant := s.writeback(ctx, req, credentialSubject); grant != nil {
				credentials[WritebackURLEnv] = grant.URL
				credentials[WritebackTokenEnv] = grant.Token
				if grant.SecretName != "" {
					ownedSecretNames = append(ownedSecretNames, grant.SecretName)
				}
			}
		}
	}

	// One decision point for the whole provider set, reached only after every
	// provider has been assessed.
	if len(pending) > 0 || len(failedToStart) > 0 {
		v := Verdict{Kind: KindLinkRequired, Message: composeLinkRequired(pending, failedToStart)}
		if len(pending) > 0 {
			// One anchor, matching upstream's contract. Re-entering the gate
			// re-assesses every provider anyway, so links the user completed
			// resolve on the next turn and only genuinely-missing ones
			// re-prompt.
			p := pending[0].pending
			v.Pending = &p
		}
		logVerdict(KindLinkRequired, req.AgentID, map[string]any{
			"pending":       pendingKeys(pending),
			"failedToStart": failedToStart,
		})
		return v, nil
	}

	actorLogin := firstNonEmpty(actorLoginFromLoop, principalLogin, s.resolveActorLogin(ctx, req))
	if actorLogin != "" {
		credentials[ActorLoginEnv] = actorLogin
	}

	verdict := Verdict{Kind: KindAuthorized, ActorLogin: actorLogin, Principal: principal, OwnedSecretNames: ownedSecretNames}
	if len(credentials) > 0 {
		if s.deps.Secret == nil {
			return s.misconfigured(req, "", "resolved credentials but no secret writer is configured")
		}
		name, err := s.deps.Secret.WriteRunCredentials(ctx, runIDFor(req), credentials)
		if err != nil {
			// An infrastructure failure, not a verdict: retrying is right, and
			// a launch must never proceed believing it has credentials it does
			// not.
			return Verdict{}, fmt.Errorf("persist run credentials: %w", err)
		}
		verdict.SecretName = name
		verdict.EnvVarNames = sortedKeys(credentials)
	}

	logVerdict(KindAuthorized, req.AgentID, map[string]any{
		// NAMES only. This is the one place holding every resolved credential
		// for a run, so it is the one place a careless log dumps all of them.
		"injecting": verdict.EnvVarNames,
		"actorLogin": func() any {
			if actorLogin == "" {
				return nil
			}
			return actorLogin
		}(),
		"principal": principal,
	})
	return verdict, nil
}

// ResolveLinked is the read-only entry point: it reports whether every
// declared provider is already satisfied, and never starts a link flow.
//
// Deliberately separate, because a paused TOOL call has no resume slot — there
// is nowhere to park a link and come back. It exists so the tool path uses the
// same keying rules as the agent path instead of hand-copying them, which is
// the second copy ADR 0030 §1 removed.
func (s *Service) ResolveLinked(ctx context.Context, req Request) (Verdict, error) {
	if len(req.IdentityProviders) == 0 {
		return Verdict{Kind: KindAuthorized, Principal: s.principalOf(req)}, nil
	}
	if s.deps.Links == nil {
		return s.misconfigured(req, "", "no identity-link gateway is configured")
	}

	principal := s.principalOf(req)
	credentials := map[string]string{}
	var missing []string

	for _, provider := range req.IdentityProviders {
		envVar, supported := ProviderEnvVar[provider]
		if !supported {
			return s.misconfigured(req, provider, fmt.Sprintf("unsupported identity provider %q", provider))
		}
		subject := req.Identity.Subject
		if CrossEntryPointProviders[provider] {
			subject = principal
		}
		token, err := s.deps.Links.Token(ctx, provider, subject)
		if err != nil || token == nil {
			missing = append(missing, label(provider))
			continue
		}
		credentials[envVar] = token.Value
	}

	if len(missing) > 0 {
		return Verdict{
			Kind: KindLinkRequired,
			Message: fmt.Sprintf(
				"This needs your %s account linked first. Ask me to run something that can set that up, then try again.",
				strings.Join(missing, " and ")),
		}, nil
	}

	verdict := Verdict{Kind: KindAuthorized, Principal: principal}
	if len(credentials) > 0 {
		if s.deps.Secret == nil {
			return s.misconfigured(req, "", "resolved credentials but no secret writer is configured")
		}
		name, err := s.deps.Secret.WriteRunCredentials(ctx, runIDFor(req), credentials)
		if err != nil {
			return Verdict{}, fmt.Errorf("persist run credentials: %w", err)
		}
		verdict.SecretName = name
		verdict.EnvVarNames = sortedKeys(credentials)
	}
	return verdict, nil
}

// planProviders builds the assessment order, putting the principal-
// establishing step FIRST so CRD provider order stays irrelevant: a
// [claude, github] Agent must not key its claude credential before the login
// is known.
func (s *Service) planProviders(ctx context.Context, req Request, principal string) ([]providerStep, string, string) {
	plan := make([]providerStep, 0, len(req.IdentityProviders)+1)
	needsPrincipal := false
	for _, p := range req.IdentityProviders {
		plan = append(plan, providerStep{name: p})
		if CrossEntryPointProviders[p] {
			needsPrincipal = true
		}
	}

	if !needsPrincipal || IsCanonicalPrincipal(principal) || !req.Identity.PerUser {
		return plan, principal, ""
	}

	// Before offering a link, ask whether this caller already HAS one. The
	// pre-flight must never prompt for a link that exists: when upstream did,
	// the prompt was surfaced and then the wait resolved the very same record
	// 0.3s later, so the turn worked and the user was asked to link on every
	// single turn regardless.
	login, err := s.deps.Links.LinkedLogin(ctx, PrincipalProvider, req.Identity.Subject)
	if err != nil {
		// A lookup that FAILED is not an answer of "no link". Treat it as
		// unknown and skip the link step rather than putting a spurious
		// one-time-setup prompt in front of someone who completed it months
		// ago: a gateway blip should cost this turn its sharing, nothing more.
		log.Printf("[authorization] could not determine whether this caller has a %s link; "+
			"continuing on the raw subject without offering one: %v", PrincipalProvider, err)
		return plan, principal, ""
	}
	if login != "" {
		return plan, CanonicalPrincipal(login), login
	}

	return append([]providerStep{{name: PrincipalProvider, principalOnly: true}}, plan...), principal, ""
}

// adopt moves a caller's pre-principal credential onto their principal.
//
// Nothing is at the principal, but this caller may well have authorized
// already — under their entry point's own subject, which is where these
// records were keyed before principals existed. Both flows now READ the
// principal; moving the record is what makes the credential the human already
// created actually BE there, instead of charging them a fresh login to
// reproduce something the gateway is still holding.
//
// Lazily, on the turn that needs it, rather than as a migration job: the
// (subject, principal) mapping is only derivable from a caller's own
// authenticated turn, and a batch job would have to invent it.
//
// Gated on PerUser for the same reason establishing a principal is: a shared
// subject's credential belongs to whoever authorized first, so moving it onto
// a sender's principal would hand it to them outright. The webhook path's
// subject IS shared, so it never adopts — it reads only what its own principal
// already holds.
func (s *Service) adopt(ctx context.Context, req Request, provider, credentialSubject string) *identitylink.Token {
	if !CrossEntryPointProviders[provider] || !req.Identity.PerUser || credentialSubject == req.Identity.Subject {
		return nil
	}
	moved, err := s.deps.Links.Rekey(ctx, provider, req.Identity.Subject, credentialSubject)
	if err != nil {
		// Best-effort throughout: a failed rekey leaves the credential where
		// it is and the turn falls back to the ordinary link prompt.
		log.Printf("[authorization] rekey failed for %s (leaving the credential where it is): %v", provider, err)
		return nil
	}
	if !moved {
		return nil
	}
	token, err := s.deps.Links.Token(ctx, provider, credentialSubject)
	if err != nil || token == nil {
		return nil
	}
	log.Printf("[authorization] adopted this caller's pre-principal %s credential onto their principal; no re-authorization needed", provider)
	return token
}

// matchingPending finds a still-live anchor from a prior turn for this exact
// (provider, subject), so a resume re-checks the SAME flow instead of
// starting a new one out from under a caller who may still be mid-way
// through it.
func (s *Service) matchingPending(req Request, provider, subject string) *PendingLink {
	p := req.Pending
	if p == nil || p.Provider != provider || p.Subject != subject {
		return nil
	}
	if time.Now().UnixMilli() >= p.ExpiresAt {
		return nil
	}
	return p
}

// recheckPending advances a still-outstanding link flow and reports whether
// a credential landed. Mirrors upstream's checkPendingIdentityLink: a device
// flow has something to actively poll, so it is polled directly rather than
// waited on — waitForLink only ever watches the store, and nothing else in
// this system ever polls GitHub on a non-live caller's behalf, so without
// this a device code the caller correctly entered would sit unredeemed
// forever and every resume would just re-show it as if nothing happened.
// authcode/page flows have no poll analogue (the browser round trip
// completes out-of-band via a callback route), so those fall back to
// waitForLink exactly as before.
//
// stillPending distinguishes "not yet, but might still land" (keep the
// anchor, park again) from "this flow is over" (expired, denied, or the
// poll itself errored) — the caller must drop a dead anchor and offer a
// fresh flow rather than silently re-showing a code GitHub has discarded.
func (s *Service) recheckPending(ctx context.Context, req Request, provider, subject string, anchor *PendingLink) (token *identitylink.Token, stillPending bool) {
	if anchor.Flow != identitylink.FlowDevice || anchor.DeviceCode == "" {
		tok := s.waitForLink(ctx, req, provider, subject)
		if tok != nil {
			return tok, false
		}
		return nil, time.Now().UnixMilli() < anchor.ExpiresAt
	}

	status, err := s.deps.Links.Poll(ctx, provider, subject, anchor.DeviceCode)
	if err != nil {
		log.Printf("[authorization] poll failed for %s@%s (treating as still pending): %v", provider, subject, err)
		return nil, time.Now().UnixMilli() < anchor.ExpiresAt
	}

	switch status {
	case identitylink.PollComplete:
		tok, err := s.deps.Links.Token(ctx, provider, subject)
		if err != nil {
			log.Printf("[authorization] token lookup after a complete poll failed for %s@%s: %v", provider, subject, err)
			return nil, false
		}
		return tok, false
	case identitylink.PollPending:
		return nil, time.Now().UnixMilli() < anchor.ExpiresAt
	default: // expired, denied
		return nil, false
	}
}

func (s *Service) startLink(ctx context.Context, provider, subject, flow string) (identitylink.StartResult, bool) {
	if flow == "" {
		flow = identitylink.FlowAuthCode
	}
	var lastErr error
	for attempt := 1; attempt <= startAttempts; attempt++ {
		started, err := s.deps.Links.Start(ctx, provider, subject, flow)
		if err == nil {
			return started, true
		}
		lastErr = err
		if attempt < startAttempts {
			log.Printf("[authorization] start failed for provider %s (attempt %d/%d); retrying so this turn can still offer every outstanding link at once: %v",
				provider, attempt, startAttempts, err)
			delay := s.deps.StartRetryDelay
			if delay <= 0 {
				delay = startRetryDelay
			}
			select {
			case <-ctx.Done():
				return identitylink.StartResult{}, false
			case <-time.After(delay):
			}
		}
	}
	log.Printf("[authorization] start failed for provider %s after %d attempts; reporting it alongside the other providers instead of failing the turn: %v",
		provider, startAttempts, lastErr)
	return identitylink.StartResult{}, false
}

// waitForLink gives the gateway a bounded chance to report the link landing,
// but only for a turn that can show the prompt live (see Request.WaitForLink).
func (s *Service) waitForLink(ctx context.Context, req Request, provider, subject string) *identitylink.Token {
	if !req.WaitForLink || s.deps.WaitForLink <= 0 {
		return nil
	}
	token, err := s.deps.Links.Wait(ctx, provider, subject, s.deps.WaitForLink)
	if err != nil {
		// A wait that threw does not mean the LINK failed — the user can still
		// complete it in their browser. Fall through to the same pending state
		// a plain timeout produces.
		log.Printf("[authorization] wait threw for provider %s; treating as not-yet-linked and parking pending: %v", provider, err)
		return nil
	}
	return token
}

func (s *Service) writeback(ctx context.Context, req Request, subject string) *identitylink.WritebackGrant {
	ttl := time.Duration(req.RunTimeoutSeconds)*time.Second + writebackGrantMargin
	grant, err := s.deps.Links.WritebackGrant(ctx, identitylink.ProviderClaudeRemote, subject, ttl)
	if err != nil {
		log.Printf("[authorization] write-back grant failed (continuing without write-back): %v", err)
		return nil
	}
	return grant
}

// resolveActorLogin asks WHO the caller is, with no side effects — it never
// starts a link. Deliberately independent of what the Agent declares: knowing
// who the caller is and provisioning them a credential are different concerns,
// and conflating them is what forced upstream's claude-code-swe-agent to
// declare `github` purely to obtain a mapping, which activated the
// delegated-write path and produced the 401.
func (s *Service) resolveActorLogin(ctx context.Context, req Request) string {
	if req.SenderLogin != "" {
		return req.SenderLogin
	}
	if s.deps.Links == nil {
		return ""
	}
	// LinkedLogin, not Token: this asks who the caller proved control of, and
	// an access token that expired overnight does not unprove it.
	login, err := s.deps.Links.LinkedLogin(ctx, identitylink.ProviderGitHub, req.Identity.Subject)
	if err != nil {
		return "" // a failed lookup must not fail the turn
	}
	return login
}

func (s *Service) principalOf(req Request) string {
	if req.Identity.Principal != "" {
		return req.Identity.Principal
	}
	if req.SenderLogin != "" {
		// A verified assertion is exactly the proof a canonical principal
		// needs, and it is the reason the webhook path always has one.
		return CanonicalPrincipal(req.SenderLogin)
	}
	return req.Identity.Subject
}

func (s *Service) misconfigured(req Request, provider, reason string) (Verdict, error) {
	detail := reason
	if provider != "" {
		detail = fmt.Sprintf("%s (provider %q)", reason, provider)
	}
	logVerdict(KindMisconfigured, req.AgentID, map[string]any{"reason": detail})
	return Verdict{
		Kind: KindMisconfigured,
		Error: fmt.Sprintf("agent %s requires identity providers (%s) but %s",
			req.AgentID, strings.Join(req.IdentityProviders, ", "), detail),
	}, nil
}

// linkPromptText renders one started flow as a clause, embedded into a larger
// sentence by its caller — hence no leading capital and no trailing period.
func linkPromptText(started identitylink.StartResult, label string) string {
	switch started.Flow {
	case identitylink.FlowDevice:
		return fmt.Sprintf("[link your %s account](%s) and enter code `%s`", label, started.VerificationURI, started.UserCode)
	case identitylink.FlowAuthCode:
		return fmt.Sprintf("[link your %s account](%s)", label, started.AuthorizeURL)
	default:
		return fmt.Sprintf("[link your %s account](%s)", label, started.PageURL)
	}
}

// composeLinkRequired states every outstanding link in one message. The batch
// shape is the point: a caller authorizes once for everything the run needs
// rather than discovering the next gap on the next trigger.
//
// Wording matches upstream's composeLinkRequiredMessage
// (apps/agent-orchestrator/src/agent/authorization-service.ts) exactly,
// including the "N accounts" count in the multi-link case — a caller-facing
// string, not just an implementation detail, and one this port had drifted
// from silently (no error, just different prose than upstream's).
func composeLinkRequired(pending []pendingEntry, failedToStart []string) string {
	var parts []string

	switch len(pending) {
	case 0:
	case 1:
		parts = append(parts, fmt.Sprintf(
			"To continue, please %s. This is a one-time step -- send any message once you're done.",
			pending[0].linkText))
	default:
		texts := make([]string, len(pending))
		for i, p := range pending {
			texts[i] = p.linkText
		}
		parts = append(parts, fmt.Sprintf(
			"To continue, I need you to link %d accounts (one-time). Please %s. Send any message once you're done.",
			len(pending), strings.Join(texts, ", and ")))
	}

	if len(failedToStart) > 0 {
		labels := strings.Join(failedToStart, " and ")
		if len(parts) > 0 {
			parts = append(parts, fmt.Sprintf(
				"I also couldn't start the %s linking step just now -- try again in a moment and I'll retry that part.", labels))
		} else {
			parts = append(parts, fmt.Sprintf(
				"I couldn't start the one-time %s account-linking step just now. Please try again in a moment -- re-apply the label or send any message and I'll retry.", labels))
		}
	}

	return strings.Join(parts, " ")
}

func pendingKeys(pending []pendingEntry) []string {
	keys := make([]string, len(pending))
	for i, p := range pending {
		keys[i] = p.provider + "@" + p.pending.Subject
	}
	return keys
}

// runIDFor names the per-run credential Secret. Stable for a given
// (agent, subject) so a retried activity reuses the object rather than
// littering one per attempt.
func runIDFor(req Request) string {
	return req.AgentID + "-" + req.Identity.Subject
}

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func firstNonEmpty(values ...string) string {
	for _, v := range values {
		if v != "" {
			return v
		}
	}
	return ""
}

// logVerdict is one line per decision, at every exit.
//
// Deliberately permanent, and at the verdict rather than scattered through the
// provider loop: with no logs at all, a run that never launched looks
// identical whether authorization refused, the launch threw, or the relay
// never arrived.
func logVerdict(kind Kind, agentID string, fields map[string]any) {
	var b strings.Builder
	fmt.Fprintf(&b, "[authorization] verdict=%s agentId=%s", kind, agentID)
	for _, k := range sortedMapKeys(fields) {
		fmt.Fprintf(&b, " %s=%v", k, fields[k])
	}
	log.Print(b.String())
}

func sortedMapKeys(m map[string]any) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// ErrNotAuthorized lets a caller treat a non-authorized verdict as an error
// where that is the natural shape, without losing the verdict itself.
var ErrNotAuthorized = errors.New("not authorized")
