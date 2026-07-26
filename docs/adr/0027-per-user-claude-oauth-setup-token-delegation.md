# 0027. `claude-code-swe-agent` runs as the calling user's own Claude subscription, via a PTY-driven `setup-token` flow

Date: 2026-07-22

## Status

Accepted

## Context

`claude-code-swe-agent` (a new sibling to `opencode-swe-agent`, running the
Claude Code CLI headless instead of the opencode CLI) needs a Claude/Anthropic
model credential to call. The default, `ANTHROPIC_API_KEY`, is a single
shared, static secret — every run bills the same metered API account and
authenticates as the same non-human identity, regardless of who is chatting.
An operator may instead want a specific run to authenticate as **their own
Claude Enterprise/Pro/Max subscription seat**, the same way ADR 0022 lets
`opencode-swe-agent` act as the calling user's own GitHub identity instead of
a shared bot credential — but for the Anthropic credential, not the GitHub
one, and per chat user rather than one shared platform token.

Claude Code CLI supports exactly this: `claude setup-token` produces a
long-lived `sk-ant-oat01-...` OAuth token (`CLAUDE_CODE_OAUTH_TOKEN`),
authenticating as whichever Claude account signs in during that command.
Unlike GitHub's OAuth flows (ADR 0022), `setup-token` has no HTTP
device-code/authorization-code exchange to call directly — it is an
interactive terminal program: it prints an authorize URL, waits for a pasted
code, then prints the resulting token. There is no non-interactive flag
(confirmed via `claude setup-token --help`). Driving it therefore requires a
PTY (a plain piped `child_process.spawn`, as used everywhere else in this
repo, does not give a real terminal to write an interactive response into),
and the resulting token's TUI-scraped text is not a stable API across CLI
versions — the same caveat this repo already carries for the CLI's headless
`--output-format stream-json` shape.

## Decision

1. **`apps/integration-gateway` gains a second, separate credential-broker
   surface, `src/claude-auth/`**, alongside (not merged into) `identity-link/`
   — the mechanics are different enough (a PTY subprocess vs. GitHub's HTTP
   device flow) that sharing one abstraction there would cost more than it
   saves:
   - `pty-setup-token.ts`'s `ClaudeSetupTokenFlows` spawns `claude setup-token`
     via `node-pty` (a new dependency — no other subprocess in this repo
     writes to a child's stdin interactively), scrapes its output for the
     authorize URL, and later writes a submitted code to its stdin, resolving
     with the captured token or a clear error. In-memory only, keyed by a
     server-generated `flowId` — the live subprocess/open stdin is inherently
     local state, not something a Redis-backed store could serialize.
   - `store.ts`'s `RedisClaudeTokenStore` is a `identity-link/store.ts`-shaped
     sibling (AES-256-GCM at rest, no TTL, pub/sub `waitForCompletion`) for
     the resulting token, keyed by subject. Reuses the existing
     `IDENTITY_LINK_ENCRYPTION_KEY` — no new encryption secret.
   - `api.ts`'s `ClaudeAuthApi` exposes two layers: internal, bearer-gated
     routes under `/claude-auth/api/{start,wait,token,invalidate}` (mirroring
     `identity-link/api.ts`'s shape, reusing its bearer token — no new
     secret), and browser-facing, capability-gated-by-`flowId` routes
     (`GET /claude-auth/:flowId`, `POST /claude-auth/:flowId/submit`) — the
     one place a human directly interacts, styled like `session-page.ts`'s
     plain server-rendered form (no bespoke chat UI needed: the link itself
     rides out through whatever channel the orchestrator's reply already
     uses, same as ADR 0022's device-flow link).
   - Opt-in via `GATEWAY_CLAUDE_AUTH_ENABLED`, independent of `identityLink`'s
     own flag, since it also requires the `claude` CLI binary to actually be
     in this image (a real build-time dependency change, not just config) —
     fails startup if enabled without identity-link's Redis/encryption-
     key/bearer-token config and the session-page `publicUrl` also present.
2. **`agent-orchestrator`'s existing per-provider identity-gate machinery
   (ADR 0022) is extended, not duplicated, to a second provider.**
   `IdentityLinkPort` (`identity-link/gateway-client.ts`) already
   parameterizes every method by `provider: string`; this decision adds a
   third `start()` flow shape, `{ flow: "page", pageUrl, expiresInSeconds }`
   (the PTY flow has no device code to poll and no out-of-band browser
   callback — like `"authcode"`, it just resolves via `getToken`/
   `waitForCompletion` once the human has pasted their code into the
   claude-auth page), and makes `IdentityLinkToken.githubLogin` optional
   (nothing reads it besides GitHub-specific display code). A new
   `ClaudeAuthGatewayClient` implements the SAME `IdentityLinkPort` against
   claude-auth's routes instead of identity-link's. `graph.ts`'s
   `delegateToAgent`/`checkPendingIdentityLink`/the agent-backed-tool path
   resolve which gateway client backs a given provider through one small
   `identityGatewayFor(provider, deps)` helper (`"claude"` →
   `deps.claudeAuthGateway`, everything else → `deps.identityLinkGateway`) —
   the pre-existing `pendingIdentityLink` session field, `PROVIDER_ENV_VAR`
   map, and link-prompt/still-waiting messages are generalized to be
   provider-aware (a label lookup) rather than hardcoded to "GitHub", but the
   overall state shape and node structure are unchanged and the existing
   GitHub flow's own tests/behavior are unaffected.
3. **Re-authentication on an expired/invalid credential, mid-run.** Because
   `claude-code-swe-agent` uses the plain `runAgent()` contract
   (`packages/agent-runtime`), it signals this by throwing an `Error` with a
   `code: "claude_auth_expired"` property when `claude-runner.ts` classifies
   an auth-looking failure; `runAgent()` already publishes any string
   `err.code` as the wire `failed.code` (previously it only ever hardcoded
   `"agent_error"`/`"config_error"`, so this is a small, backward-compatible
   generalization, not a breaking change). On the orchestrator side, a new
   `handleAgentTurnFailure` helper recognizes `AgentTurnFailedError` with that
   exact code: instead of surfacing a hard `state.error`, it calls
   `claudeAuthGateway.invalidate("claude", subject)` (a new
   `POST /claude-auth/api/invalidate` route, deleting the stored token) and
   returns a plain, actionable `result` telling the user to simply retry —
   the next delegation attempt's pre-flight `getToken` then finds nothing
   linked and starts a fresh `setup-token` flow automatically, same as a
   first-time link.
4. **`claude-code-swe-agent`'s own Helm chart** gains an
   `identityLink.providers` list that may include `"claude"` alongside/
   instead of `"github"` (same field opencode-swe-agent's chart already has
   for GitHub — no template change needed, since `identityProviders` was
   already a plain string list on the `Agent` CR). `CLAUDE_CODE_OAUTH_TOKEN`
   for a per-run delegated token lands via the exact same generic
   `AgentRunLauncher.launch()` `secretEnv` mechanism ADR 0022 already built —
   no launcher changes.

## Consequences

- Someone can run `claude-code-swe-agent` against their own Claude
  subscription seat instead of metered `ANTHROPIC_API_KEY` billing, per chat
  user, with the same "one-time link, then silent forever" posture ADR 0022
  established for GitHub — except this "silent forever" is weaker in
  practice: `claude setup-token`'s resulting token's actual lifetime/refresh
  behavior is not something this repo controls or has independently verified
  (unlike GitHub's App-issued refresh tokens), so a real deployment should
  expect to occasionally hit the re-auth path this ADR builds for that
  reason, not treat it as a rare edge case.
- A new native dependency (`node-pty`) and a new build-time dependency (the
  `claude` CLI binary) are added to `integration-gateway`'s image — a
  previously very small, low-privilege, no-native-deps service. This is
  scoped behind `claudeAuth.enabled` (env var + Helm value), but the image
  itself always carries the extra weight once built with this feature
  compiled in.
- `claude setup-token`'s TUI output (the authorize-URL wording, the token
  line) is scraped via regex, not a documented API — the same fragility this
  repo already accepts for the CLI's headless JSON output. Pin the CLI
  version in both `claude-code-swe-agent`'s and `integration-gateway`'s
  Dockerfiles and treat a version bump as something to re-test, not a routine
  update.
- Mid-run re-authentication is only wired at the two main delegation call
  sites (`delegateToAgent`'s fresh launch, `checkActiveAgentRun`'s
  continuation) — the agent-backed-tool path (a Skill's `toolRefs`/
  `agentRefs` reaching an identity-gated agent) inherits ADR 0022's existing
  "v1 scope cut" of never starting/resuming a link from within that path at
  all, so an expired Claude credential reached that way still surfaces as a
  plain `state.error` rather than an auto-recoverable prompt.
- `IdentityLinkToken.githubLogin` becoming optional, and `IdentityLinkPort`
  gaining an optional `invalidate`, are both non-breaking widenings of an
  interface `opencode-swe-agent`'s own identity-link path already depends on
  — verified via the full existing GitHub-flow test suite passing unchanged.

## Amendment (2026-07-24): a link that survives its first token refresh, and a re-auth signal that actually fires

A production `ai-review` run (AgentRun `fc9f0896`) died 11 seconds in with
`Login expired · Please run /login` roughly 48 minutes after an identical run
had succeeded on the same stored credential. Investigating it turned up three
separate defects, two of which made this ADR's own re-auth design unreachable
in practice. All three are fixed together, since none of them alone produces a
working recovery.

### 1. The `claude-remote` credential was never refreshable

The full-login blob is stored once (`claudeAuthLogin:<subject>`) and copied
into each run's HOME, an emptyDir. Claude Code refreshes its access token in
that pod, and Anthropic **rotates the refresh token** when it does, so the copy
still in Redis is dead as soon as the first run refreshes — while the refreshed
file dies with the pod. "Silent forever" therefore lasted exactly one access
token, and every run after that prompted the human to re-link an account they
had already linked hours earlier.

Fixed by writing the refreshed file back:

- `ClaudeTokenStore.createWritebackToken`/`resolveWritebackToken` mint and
  resolve an opaque, TTL'd grant (stored SHA-256-hashed) that authorizes
  exactly one thing: replacing one subject's `login` record.
- `POST /claude-auth/api/writeback-token` (bearer-gated) mints a grant;
  agent-orchestrator calls it at launch and injects the result as
  `CLAUDE_CREDENTIALS_WRITEBACK_URL`/`_TOKEN` via the same `secretEnv` channel
  as the credential itself. The gateway's own bearer — which can read and mint
  credentials for every subject — deliberately never enters a run's
  environment.
- `POST /claude-auth/api/refresh` (grant-gated, dispatched before the
  master-bearer check) stores the blob. The subject comes from the grant, never
  the request body, so a run can only overwrite its own credential; the body
  must parse as JSON; and because `ClaudeTokenStore.set` swallows its own Redis
  errors by design, the write is read back and 502s rather than silently
  dropped.
- claude-code-swe-agent posts its credentials file back after every turn
  (success or failure — the refresh happened either way), skipping the common
  case where the file is byte-identical to the injected blob. Best-effort
  throughout: the turn's work is already done, so losing a refresh must never
  fail a completed run.

This does not implement an Anthropic-side refresh call in the orchestrator. The
CLI already drives the refresh; re-implementing that undocumented exchange
would be a second, unverifiable path to the same result. A credential that ages
out with no run in between still expires — but that now lands on the recovery
path below instead of looking like a finished turn.

### 2. An auth failure was reported as a *successful* turn

The interactive Remote Control session recorded `Login expired · Please run
/login` as its assistant text and wrote a `turn_duration` entry, so
`runClaudeTurnRemoteControlled` saw `turnComplete` and returned
`failed: false`. The credential error reached the user as a turn summary — "The
agent produced no pushable repository or pull request. Details: Login expired ·
Please run /login" — and nothing downstream could act on it, because nothing
upstream had called it a failure. The one-shot `-p` path had the same hole for a
`result` event with `is_error` unset.

Both paths now treat a completed turn whose entire output is a short
credential complaint as an auth failure (`isAuthFailureDisguisedAsSuccess`,
length-bounded so a review that merely *discusses* credentials is unaffected),
and `"login expired"` joins `AUTH_ERROR_SUBSTRINGS`.

### 3. The `claude_auth_expired` code was never emitted, and named the wrong credential

This ADR states that `runAgent()` "already publishes any string `err.code`".
It did not: `runtime.ts` hardcoded `agent_error`/`config_error`, and
claude-code-swe-agent threw a plain `Error`. `handleAgentTurnFailure` was
therefore dead code from the day it was written.

- `packages/agent-runtime` exports `AgentFailure(code, message)`, and
  `runAgent()` forwards its code onto the wire. Recognized by `instanceof` or
  `name === "AgentFailure"` (realm-safe), never by a bare `.code`, so Node's
  own `ENOENT`/`ECONNREFUSED` don't start leaking as failure codes.
- There are now two codes, because the recovery is to DELETE the stale record
  and the two providers' records are stored separately:
  `claude_auth_expired` → `claude`, `claude_remote_auth_expired` →
  `claude-remote`. `handleAgentTurnFailure` picks the provider from the code
  rather than from `identityProviders[0]`, which for an agent declaring both
  always invalidated the setup-token — leaving the login blob that actually
  failed in place to fail again, while forcing a pointless re-link of a
  credential that was fine.
- The recovery **starts the replacement link in the same turn** and returns its
  URL, rather than invalidating the credential and asking the user to trigger
  the whole request again. The first cut did the latter, and a live test on #146
  showed why that isn't a recovery: the only thing posted was "re-apply the
  label to try again" — a dead end dressed up as a fix, costing a round trip to
  receive a link that could have been in the first reply. It returns the same
  `pendingIdentityLink`/`identityLinkPending` shape as the first-time link
  prompt, so integration-gateway's existing `waitAndResume` picks up the
  interrupted request automatically once the link completes, with no new
  contract and no second trigger. A "re-apply the label" / "send your request
  again" message (branching on whether the turn has a live channel, since a
  label-triggered run has no "send again") survives only as the fallback for
  when the replacement flow itself can't be started.

### Consequences

- A `claude-remote` link now survives token rotation for as long as runs keep
  happening, which is the difference between "link once" and "re-link every few
  hours".
- Each `claude-remote` AgentRun carries a bearer grant scoped to one subject
  and one operation, expiring at run timeout + 15 minutes. That is strictly
  less authority than the gateway bearer, and strictly more than the run had
  before — a run that is compromised can replace its own initiator's stored
  Claude credential with any valid-JSON blob until the grant expires.
- Auth-error detection stays substring matching against CLI output (the CLI
  exposes no stable machine-readable code), now including output the CLI
  presents as a normal turn result. A future CLI wording change lands the run
  back in the generic-failure path, not in a wrong-but-confident one.
