# 0029. Claude credentials are keyed by a canonical `github:<login>` subject shared across entry points

Date: 2026-07-24

## Status

Accepted

## Context

A human who authorizes their Claude credential during an `ai-triage` run and
then opens chat to trigger the SWE agent is asked to authorize again — and
again in the other direction. Nothing is expiring or being evicted; the
credential is cached exactly as designed. It is simply cached under a key the
other entry point never looks up.

`ClaudeTokenStore` keys every record by `identity.subject`
(`RedisClaudeTokenStore.keyFor` = prefix + subject), and the two entry points
resolve fundamentally different subjects:

- **Triage / AI review.** `integration-gateway` resolves the sender's GitHub
  login for its own permission gate, but then calls `/invoke` with its **own
  OIDC service token**. agent-orchestrator resolves the subject from that
  token, so every webhook-driven turn shares one service subject, identical no
  matter who applied the label. The login is never forwarded.
- **Chat.** `OpenWebUiForwardedUserResolver` resolves `openwebui:<id>` from
  Open WebUI's per-request signed JWT — correctly per-user (ADR 0022's
  successor fix), and deliberately namespaced so it cannot collide with an
  upstream IdP subject.

So an authorization performed in triage writes
`claudeAuthLogin:<service-subject>`, and chat reads
`claudeAuthLogin:openwebui:<id>`, misses, and starts a fresh flow. There is no
stable per-user identifier present in both flows, and nothing maps between
them.

### The trap this has to avoid

The obvious fix — re-key the credential under a derived subject — was tried in
PR #144 (`linkSubjectFor`) and reverted in PR #145. It re-keyed the identity
*gate* but left the resume path and the terminal `/invoke` record still
deriving the subject from `identity.subject`. The link was therefore **stored**
under one subject and **waited on** under another, so it never resolved and the
user was re-prompted forever. The failure was not the choice of key; it was
applying it at some call sites and not others.

## Decision

Introduce one canonical credential subject, `github:<login>` (lower-cased —
webhooks echo a login's original casing while the OAuth API normalizes it, and
two casings would key two records), resolved by a single shared helper,
`resolveCredentialSubject`, used at **every** call site.

The login comes from whichever verified source the entry point has:

- **Triage / review**: `senderLogin`, newly plumbed through `/invoke`'s `event`
  descriptor onto `AgentState`. GitHub vouches for it — the webhook signature
  is verified upstream, and the gateway drops the event outright if the sender
  resolves to no identity.
- **Chat**: the `githubLogin` already stored on the caller's own `github`
  identity link, which they established by proving control of that account
  through the device/authcode flow.

Neither is caller-supplied text, so a caller cannot name an arbitrary login and
inherit someone else's credential. `senderLogin` takes precedence, so a triage
turn never inherits the service account's own link.

Three constraints make this safe where PR #144 was not:

1. **Only `claude` and `claude-remote` are canonicalized.** The `github` link
   is what *produces* the mapping, so canonicalizing it would be circular; it
   stays on the raw subject. Triage's GitHub writes continue to use the App
   installation token, untouched.
2. **The subject is recorded, never recomputed.** `pendingIdentityLink` gains a
   `subject` field holding the subject the link was actually started against.
   The resume path, the invalidate path, the write-back grant, and the terminal
   `/invoke` `identityLink.subject` (which `waitAndResume` blocks on) all read
   that stored value. Store and wait cannot drift apart.
3. **Unresolvable login falls back to the raw subject**, degrading to exactly
   the old per-entry-point behavior rather than failing the turn.

`claude-code-swe-agent` declares `identityProviders: [github, claude,
claude-remote]` in production, **in that order**. The gate resolves providers
in sequence, so `github` must come first: its link is what makes the canonical
subject resolvable for the two that follow.

## Consequences

A Claude authorization done in either entry point is now honored in both.

Chat users must complete a one-time GitHub link before `claude-code-swe-agent`
will run. This is the real cost of the decision, and it was chosen knowingly
over the alternative (fall back to the raw subject when no link exists), which
would have avoided the extra step but left cross-flow sharing silently
unavailable to everyone who never linked. Git operations do not depend on that
link — `resolveGithubToken` still prefers the App installation token whenever
all three App fields are configured, so commits keep attributing to the App
identity. The per-user `GITHUB_TOKEN` the link injects is the same dual-token
pattern `opencode-swe-agent` already uses, and it makes per-user attribution
available as a later, separate choice.

Two limits worth stating plainly:

- A user whose chat account and GitHub account are different humans would share
  one credential key. That is inherent to choosing GitHub identity as canonical
  and is the intended semantics, not a leak: reaching that state requires
  completing the device flow against that GitHub account.
- Credentials authorized *before* this change remain under their old
  per-entry-point keys. They are not migrated; the first authorization after
  the change writes the canonical record. The practical effect is at most one
  more prompt per user, once.

Sessions that parked a pending link before `pendingIdentityLink.subject`
existed resume against the raw subject, which is what those links were started
against — so an in-flight link at deploy time still completes.
