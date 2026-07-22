# integration-gateway

GitHub Issues adapter for the event-integrations proposal
([docs/integrations-gateway.md](../../docs/integrations-gateway.md)). This is
a phase-1 implementation of just the **conversational path** for one channel
(GitHub): the FAAS/direct-invoke path described in the proposal is
intentionally out of scope here.

## Flow

1. An issue is opened, or a comment is added, in a repo whose webhook (or
   GitHub App subscription) points at this service's `POST /webhooks/github`.
2. The gateway verifies the request's `X-Hub-Signature-256` HMAC, resolves
   the sender's GitHub login to an identity (static allowlist —
   `GATEWAY_GITHUB_IDENTITIES`, see `src/identity.ts`), and forwards the
   issue/comment text to `agent-orchestrator`'s existing `POST /invoke`,
   scoped to a session id of `github:<owner>/<repo>#<issueNumber>`.
3. Whatever the orchestrator's turn returns (a clarifying question, or a
   completion message) is posted back as an issue comment.
4. A follow-up comment on the same issue reuses the same session id, so
   `agent-orchestrator`'s existing `checkActiveAgentRun`/`AgentSession.ask()`
   mechanism resumes the same delegated Agent run instead of starting a new
   one — no new "ask vs. do" logic was built for this; it already existed
   for the SWE agent (`apps/opencode-swe-agent`).
5. When the reporter says "start work" (or anything else), that's just more
   turn text — opencode-swe-agent decides internally when to stop asking
   and start coding, and opens the PR itself.

## Configuration

See `src/config.ts` for the full list. Notable ones:

- `GITHUB_WEBHOOK_SECRET` (required) — shared secret configured on the
  GitHub webhook/App.
- `GATEWAY_ORCHESTRATOR_URL` / `GATEWAY_ORCHESTRATOR_TOKEN` (required) —
  where to reach `agent-orchestrator`'s `/invoke` API and the bearer token
  this gateway authenticates as (must resolve, via the orchestrator's own
  identity resolver, to a role allowed to reach the SWE agent).
- `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_INSTALLATION_ID`
  (preferred) or `GITHUB_TOKEN` (PAT fallback) — used only to post issue
  comments (`@controller-agent/github-app-auth`, ADR 0018). Reuses the same
  App as `apps/opencode-swe-agent` if you extend it with `Issues: read &
  write` and subscribe it to the `issues`/`issue_comment` webhook events,
  rather than registering a second App.
- `GATEWAY_GITHUB_BOT_LOGIN` — the App/bot's own login, so its own comments
  are ignored (loop prevention; a second guard also skips any comment body
  containing the gateway's own reply marker).
- `GATEWAY_GITHUB_TEAM_ROLES` — **prod-grade, preferred**. JSON map of
  `{ "<org>/<team-slug>": ["role", ...] }`. A sender is granted the union of
  roles for every team they're an *active* member of, checked live against
  GitHub's REST API (`GithubTeamMembershipResolver`) and cached briefly
  (5 min for a member, 1 min for a non-member) to bound API calls. Adding or
  removing a person is a GitHub org/team membership change — no commit or
  redeploy needed. Uses the same GitHub App/PAT credentials as the reply
  client, so it needs `Members: Read` org permission (App) or `read:org`
  scope (PAT).
- `GATEWAY_GITHUB_IDENTITIES` — dev/test-grade static allowlist, JSON map of
  `{ "<github-login>": { "subject": "...", "roles": ["..."] } }`. Unknown
  logins are dropped (fail-closed). `CompositeGithubIdentityResolver` only
  falls back to this when `GATEWAY_GITHUB_TEAM_ROLES` grants nothing for that
  login — useful for a service account that isn't a team member, or while
  migrating people onto team-based access. See the doc-comment on
  `GithubIdentityResolver` in `src/identity.ts`.
- `GATEWAY_POLL_INTERVAL_MS` / `GATEWAY_POLL_TIMEOUT_MS` — this gateway
  polls `GET /invoke/:id` rather than the orchestrator pushing a result,
  since it doesn't launch the run itself. This is a deliberate stand-in for
  the "gateway registers its own callback URL" open question in
  `docs/integrations-gateway.md` — push-based delivery is a documented
  follow-up, not built in this phase.

## Identity-link credential broker

Independent of the GitHub-webhook relay above, this gateway also exposes an
internal API that lets `agent-orchestrator` link a chat user's own GitHub
account (via OAuth Device Flow -- no redirect/callback URL, the user just
visits a URL and types a code) and later fetch a currently-valid token for
that user, refreshed transparently. This is what lets a coding agent act as a
specific GitHub user instead of a shared bot/PAT. See
`src/identity-link/device-flow-linker.ts` and `src/identity-link/store.ts`.

All three routes require `Authorization: Bearer <GATEWAY_IDENTITY_LINK_TOKEN>`
(a separate token from `GATEWAY_ORCHESTRATOR_TOKEN`, since that one flows the
opposite direction):

- `POST /identity-link/:provider/start` -- body
  `{ "subject": "...", "flow"?: "device" | "authcode" }`. Only
  `provider = "github"` is supported today. `flow` defaults to `"device"` at
  this API layer (a caller-agnostic default -- agent-orchestrator itself may
  default differently for its own callers). An unrecognized `flow` value is a
  `400`.
  - `flow: "device"` (default) returns
    `{ flow: "device", verificationUri, userCode, deviceCode, expiresInSeconds, pollIntervalSeconds }`
    -- show `verificationUri`/`userCode` to the user, then poll with `deviceCode`.
  - `flow: "authcode"` returns `{ flow: "authcode", authorizeUrl, expiresInSeconds }`
    -- redirect the user's browser to `authorizeUrl`; GitHub redirects back to
    `GET /identity-link/:provider/callback` (see below) once they approve or
    decline.
- `POST /identity-link/:provider/poll` -- body
  `{ "subject": "...", "deviceCode": "..." }`. Returns
  `{ "status": "pending" | "complete" | "expired" | "denied" }`. Only used by
  the device flow -- the authcode flow completes via the callback route
  instead.
- `GET /identity-link/:provider/token?subject=...` -- returns
  `{ "token": "...", "githubLogin": "..." }` (200) if a link exists (refreshing
  it first if it's expired or close to expiring), or `404` if the subject has
  never linked (or its refresh token has died -- the caller must re-link).
- `GET /identity-link/:provider/callback?code=...&state=...` -- the
  authorization-code flow's OAuth redirect target. Unlike the three routes
  above, this one is **not** bearer-authed (`GatewayServer.handleRequest`
  intercepts it before the bearer-gated dispatch) since it's hit directly by
  the end user's browser via GitHub's redirect, which can't carry our
  internal bearer token. Also handles GitHub's denial redirect shape
  (`?error=access_denied&state=...`, rendered as a friendly "you can try
  again from chat" page, `200`). Renders small, self-contained HTML pages
  (no external assets) for every outcome -- missing `state`/`code` (`400`),
  an unsupported provider (`400`), an expired/already-used/tampered `state`
  or code (`400`), or success (`200`, "you can close this tab").

Required env vars for this API:

- `GITHUB_APP_CLIENT_ID` -- the GitHub App's public client id (not a secret)
  used to start device-flow and authcode-flow links.
- `IDENTITY_LINK_ENCRYPTION_KEY` -- a 32-byte AES-256-GCM key, base64- or
  hex-encoded, used to encrypt linked tokens at rest in Redis.
- `GATEWAY_IDENTITY_LINK_TOKEN` -- the bearer token `agent-orchestrator`
  authenticates to this API with.
- `AGENT_REDIS_URL` -- Redis connection string for the durable identity-link
  store (same env var `agent-orchestrator` uses for its own session store).
  Unlike that session store, identity links have no TTL and no in-memory
  fallback -- they're required to persist until the user re-links.
- `GITHUB_DEVICE_FLOW_SCOPE` (optional, defaults to `repo`) -- OAuth scope
  requested when starting a link (used by both flows).
- `GITHUB_APP_CLIENT_SECRET` (optional, empty by default) -- the GitHub App's
  client secret. Only required if the `authcode` flow is actually used
  (`start`'s `flow: "authcode"` and the `/callback` route); a device-flow-only
  deployment can leave this unset.
- `IDENTITY_LINK_STATE_SECRET` (optional, empty by default) -- HMAC secret
  used to sign/verify the authcode flow's CSRF `state` param. Same
  device-flow-only exemption as above.
- `GITHUB_OAUTH_REDIRECT_URI` (optional, empty by default, not a secret) --
  must exactly match the GitHub App's registered OAuth callback URL (i.e.
  this service's own `.../identity-link/github/callback` URL, publicly
  reachable). Same device-flow-only exemption as above.

## Known limitations (v1)

- Identity resolution is a static allowlist, not real GitHub authorization.
- Result delivery is poll-based, bounded by `GATEWAY_POLL_TIMEOUT_MS` — a
  turn that runs longer than that is reported as timed out even if the
  underlying agent run is still in progress.
- No rate limiting/abuse controls per repo or sender.
