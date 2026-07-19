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
- `GATEWAY_GITHUB_IDENTITIES` — JSON map of
  `{ "<github-login>": { "subject": "...", "roles": ["..."] } }`. Unknown
  logins are dropped (fail-closed) — this is a dev/test-grade static
  allowlist, not real GitHub-org/team-membership verification; see the
  doc-comment on `GithubIdentityResolver` for the intended follow-up.
- `GATEWAY_POLL_INTERVAL_MS` / `GATEWAY_POLL_TIMEOUT_MS` — this gateway
  polls `GET /invoke/:id` rather than the orchestrator pushing a result,
  since it doesn't launch the run itself. This is a deliberate stand-in for
  the "gateway registers its own callback URL" open question in
  `docs/integrations-gateway.md` — push-based delivery is a documented
  follow-up, not built in this phase.

## Known limitations (v1)

- Identity resolution is a static allowlist, not real GitHub authorization.
- Result delivery is poll-based, bounded by `GATEWAY_POLL_TIMEOUT_MS` — a
  turn that runs longer than that is reported as timed out even if the
  underlying agent run is still in progress.
- No rate limiting/abuse controls per repo or sender.
