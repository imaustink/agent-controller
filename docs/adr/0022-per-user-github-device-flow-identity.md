# 0022. Agent GitHub operations use the calling user's own linked GitHub identity, via OAuth Device Flow

Date: 2026-07-20

## Status

Accepted

## Context

`opencode-swe-agent` (ADR 0016) authenticates every git/GitHub operation with
one shared, static credential regardless of who is chatting: either the
`GITHUB_TOKEN` fine-grained PAT, or a GitHub App **installation** token (ADR
0018). Every PR/commit is attributed to the same bot identity, and the
credential's blast radius is bounded only by whatever repos that PAT/App
installation was scoped to — not by what the actual requesting human is
allowed to do on GitHub. There is also no PAT at all in the target posture:
long-lived static tokens are the thing being removed here, not merely
supplemented.

Two structural gaps stood in the way of "act as the calling user" before this
decision:

1. **No per-caller persistent store.** `SessionRecord`
   (`apps/agent-orchestrator/src/session/types.ts`) is keyed by conversation
   id and scoped to session TTL (ADR 0012) — there was nowhere to durably
   remember "this identity subject's GitHub account is *this* GitHub
   account," independent of any one conversation.
2. **No per-invocation credential injection.** `AgentRunSpec`
   (`controllers/core-controller/api/v1alpha1/agentrun_types.go`) carried
   only `agentRef`/`goal`/`callback`/`timeoutSeconds` — every credential an
   Agent's Job saw came from the Agent CR's own static `secretEnv`, baked in
   at deploy time and identical for every invocation.

Login to the system (Open WebUI, via Google OIDC — `charts/agent-controller/
values-production.yaml`'s `identityResolver: oidc`) authenticates a Google
identity, which cannot authenticate GitHub — there was no existing GitHub
identity anywhere in the system to reuse. Getting a per-user GitHub credential
therefore requires an explicit, one-time linking step. GitHub's **OAuth
Device Flow** was chosen for that step: no redirect/callback URL is needed
(unlike the authorization-code web flow), and a GitHub App with Device Flow
enabled needs only its public `client_id` — no client secret — to both start
and poll the flow. The trade-off accepted: linking still requires one manual
action from the user (visit a URL, type a short code) — this cannot be made
fully invisible — but it happens **at most once per person**: the resulting
credential is durably stored and transparently refreshed (GitHub Apps issue
~8h user tokens with a ~6-month rotating refresh token), so no subsequent
coding request ever re-prompts the same user.

## Decision

1. **`apps/integration-gateway` becomes a general external-identity
   credential broker**, in addition to its existing GitHub-webhook-relay
   role — it already sits at the boundary between the cluster and GitHub
   (App JWT/installation-token minting for posting issue comments), so it is
   the natural owner of the reverse direction too: linking a specific
   person's own GitHub account.
   - `packages/github-app-auth/src/deviceFlow.ts` adds `startDeviceFlow`,
     `pollDeviceFlow`, `refreshUserToken` — thin wrappers around GitHub's
     `/login/device/code` and `/login/oauth/access_token` endpoints, using
     only the App's `client_id` (new config, public, not a secret).
   - `apps/integration-gateway/src/identity-link/` adds a subject-keyed,
     durable store (`RedisIdentityLinkStore` — no session TTL, since an
     account link persists until the user re-links; fields encrypted at rest
     with AES-256-GCM under a new `IDENTITY_LINK_ENCRYPTION_KEY`), a
     `GithubDeviceFlowLinker` orchestrating start/poll/refresh against that
     store, and a small internal bearer-authed API:
     `POST /identity-link/:provider/start`, `POST
     /identity-link/:provider/poll`, `GET /identity-link/:provider/token`
     (the last one refreshes transparently when the stored token is
     near/past expiry, so callers never see a stale token or need to think
     about refresh).
2. **`agent-orchestrator` gates delegation on a linked identity, generally —
   not hardcoded to the swe agent.** The `Agent` CRD gains an optional
   `IdentityProviders []string` field (e.g. `["github"]`): any Agent can opt
   in by declaring it, with zero new orchestrator code required per agent.
   - `graph.ts`'s `delegateToAgent`, before launching, checks the selected
     agent's `identityProviders`; if a provider's token isn't yet linked for
     `state.identity.subject`, it starts a device-flow link and ends the
     turn with a chat message containing the verification URL and user
     code, persisting a new `pendingIdentityLink` session field (the
     identity-link analogue of `activeAgentId`/`activeAgentRunId` — a
     delegation attempt paused on one-time authorization has no live
     AgentRun/NATS channel yet, unlike an in-flight agent question, so it
     needs its own session-carried pending state rather than reusing
     `checkActiveAgentRun`'s mechanism).
   - A new node `checkPendingIdentityLink` (mirroring `checkActiveAgentRun`'s
     structure) runs early each turn: if a link is pending, it polls once;
     `"complete"` re-fetches the agent (same RBAC re-check discipline as
     every other session-continuity node) and resumes straight into
     `delegateToAgent` with the now-available token; `"pending"` (before
     expiry) re-prompts and ends the turn; `"expired"`/`"denied"` clears the
     pending state and falls through to ordinary re-selection.
3. **Per-invocation credential injection via `AgentRunSpec.SecretEnv`.**
   `AgentRunSpec` gains an optional `SecretEnv []SecretEnvVar` (reusing the
   type already defined for `AgentSpec`) — a per-run override/addition to the
   Agent template's static `secretEnv`, keyed by env var name (an AgentRun-
   level entry wins on collision). The Go reconciler's `createJob` merges
   `AgentRunSpec.SecretEnv` over `AgentSpec.SecretEnv` by name when building
   the Job. `AgentRunLauncher` (TypeScript) resolves the linked token via the
   gateway, creates a short-lived per-run k8s `Secret` (never embedding the
   plaintext token in the `AgentRun` CR itself — CRs aren't RBAC-hidden the
   way Secrets are), references it via `AgentRunSpec.SecretEnv` as
   `GITHUB_TOKEN`, and patches the Secret's `ownerReferences` to the created
   `AgentRun` immediately after, so k8s's own garbage collector removes it
   when the run (and its Job) is cleaned up.
4. **`opencode-swe-agent` needs no code changes.** It already reads
   `GITHUB_TOKEN` via `resolveGithubToken` (ADR 0016/0018); this decision
   just changes what populates that env var for identity-linked deployments
   — a specific user's token instead of a bot/App-installation token. Its
   Helm chart (`charts/community-components/templates/agent-opencode-swe.yaml`)
   gains an `identityLink.enabled` flag: when true, `identityProviders:
   [github]` is set on the Agent CR and its static `GITHUB_TOKEN`/App-
   installation `secretEnv` entries are omitted entirely (no shared
   credential baked in at all); `ANTHROPIC_API_KEY` (a model credential,
   unrelated to GitHub identity) is unaffected either way. Left disabled by
   default — existing PAT/App-installation deployments are unchanged.
5. **The App JWT/installation-token machinery (`packages/github-app-auth`'s
   `signAppJwt`/`mintInstallationToken`, ADR 0018) is not removed.** It keeps
   serving `integration-gateway`'s own bot-identity use (posting issue
   comments as the gateway's own bot login) — a legitimately-bot concern,
   distinct from acting as a specific human for coding-agent git/gh
   operations.

## Consequences

- PRs/commits opened by an identity-linked Agent are attributed to the
  actual requesting person, and the credential's blast radius is bounded by
  **that person's own GitHub permissions** — strictly narrower than a shared
  PAT/App-installation token whose scope was set once for every caller. The
  existing deny-rule (`DENY_BASH_PATTERNS`) and branch-protection defense-in-
  depth (ADR 0013) is unchanged and still required regardless of whose token
  is in play.
- A brand-new user's first coding request costs one extra round trip (visit
  a URL, type a code); every request after that — for that person, across
  every identity-requiring Agent — is silent, refreshed transparently by the
  gateway's `token` endpoint.
- New durable, secret-bearing state: the identity-link store holds every
  linked user's GitHub token/refresh-token (encrypted at rest). This needs
  the same operational rigor as `opencode-swe-secrets` — encryption key
  rotation, and no plaintext logging (the redaction patterns in
  `security/redact.ts` already cover GitHub tokens generically via the
  `gh[opsu]_...` pattern).
- `agent-orchestrator`'s k8s RBAC widens (new `secrets: create`/`patch`
  verbs, gated behind the same `identityLink.enabled` flag as the LocalTool-
  driven `secrets: get` grant is gated behind `localTool.enabled`) — only
  added when this feature is turned on.
- A caller whose linked refresh token itself expires (~6 months idle) or is
  revoked must re-link once, the same one-time device-flow step as before;
  this is treated as an acceptable edge case, not a regression, since it
  mirrors how any OAuth-linked third-party account naturally lapses.
