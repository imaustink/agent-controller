# 0025. Triage agent improvements: upfront "starting work" comment + session page

Status: accepted

## Context

Issue #81 ("Issues Triage Agent Improvements") asked for two things on the
`issues.labeled` → `opencode-swe-agent` triage path (ADR 0024):

1. The agent should post something on the issue *before* it starts work —
   either a clarifying question (already handled: `checkActiveAgentRun`/
   `AgentSession.ask()`, ADR 0016/0017), or an acknowledgement that it's
   starting, if it already has what it needs.
2. Once a session is running, drop a link to an interactive page where the
   session's output can be watched and additional prompts sent.

Before this, `GatewayServer.relayAndReply` (`apps/integration-gateway/src/
server.ts`) only ever posted one comment, after `OrchestratorClient.invoke`'s
full accept-then-poll cycle completed (up to `GATEWAY_POLL_TIMEOUT_MS`, 15
minutes by default) — nothing was posted at trigger time, and there was no
interactive surface: the only existing chat-capable UI is the optional Open
WebUI deployment (`charts/agent-controller`'s `openwebui` dependency) in
front of `agent-orchestrator`'s OpenAI-compatible facade (ADR 0007/0012), but
its `X-OpenWebUI-Chat-Id` is a chat id *it* generates, not one this gateway
can mint or deep-link into for a specific GitHub-issue session.

We considered pointing the link at Open WebUI directly. Rejected: there's no
way to make Open WebUI open a *specific* pre-existing conversation scoped to
a `github:<owner>/<repo>#<issueNumber>` session id without either changing
Open WebUI itself (out of scope, it's a separate upstream project) or
seeding a chat record through its own API in a way its schema doesn't
support user-assigned ids for. A generic link to Open WebUI's landing page
wouldn't actually be scoped to *this* session, which is the entire point of
requirement 2.

## Decision

**Upfront comment (requirement 1).** `relayAndReply` now posts a "Starting
work on this now…" comment immediately, before calling
`OrchestratorClient.invoke`, but *only* on the `issues.labeled` trigger path
(discriminated by the existing `event` parameter, which is only ever set on
that path) — not on ordinary conversational opened/comment replies, which
are meant to feel like near-instant chat and where an extra comment would
just be noise. The existing ask-a-clarifying-question behavior is unchanged;
this is additive, not a replacement.

**Session page (requirement 2).** A new, minimal, server-rendered page
owned by `integration-gateway` itself — no new service, no client
JavaScript:

- `SessionPageStore` (`src/session-page-store.ts`) keyed by both `sessionId`
  (`github:<owner>/<repo>#<issueNumber>`) and an opaque `token` (256-bit
  random, base64url) that's the page's bearer-capability credential.
  `InMemorySessionPageStore` (default) or `RedisSessionPageStore` (when
  `SESSION_PAGE_REDIS_URL` is set) so a posted link survives a pod restart —
  same "works standalone, better with Redis" posture as the rest of this
  app, modeled on `RedisIdentityLinkStore`'s soft-fail-and-log discipline
  rather than its stricter durable-secret handling (nothing stored here is
  secret).
- `GET /sessions/:token` renders the session's turn history; a pending turn
  adds a 5s `<meta http-equiv="refresh">` rather than any client-side
  polling JS.
- `POST /sessions/:token/prompts` accepts a new prompt, relays it into the
  *same* orchestrator session (`OrchestratorClient.invoke(prompt, sessionId,
  "device")`, no `event` descriptor — it's not a re-trigger of the labeled
  route, just another conversational turn), and — like the webhook path —
  posts the eventual result back as an issue comment too, so the GitHub
  issue stays the source of truth for anyone not watching the page.
- `SessionPageStore.addTurn` is a no-op unless an entry already exists for
  that `sessionId` — a plain issue that was never triaged never gets a page
  just because a turn happened to run on its session id; only the labeled
  trigger (via `getOrCreate`) or an already-existing page's own prompt form
  can add turns.
- Whole feature is opt-in and off by default: `GATEWAY_PUBLIC_URL` unset
  means no comment link is ever posted and the page routes are effectively
  unreachable (no token is ever minted).

## Consequences

- No new Kubernetes API surface, Service, or port — same "gateway stays
  dumb" posture as ADR 0024, just two more HTTP routes on the existing
  webhook-relay server.
- The page's only access control is possession of the unguessable `token` in
  the URL — no per-user identity check on the prompt-submission route,
  unlike the webhook path's real GitHub identity resolution. Acceptable for
  a capability-URL posted into a comment on the (already access-controlled)
  originating issue, but worth reconsidering if this ever needs to gate
  something more sensitive than "send another prompt into a session that
  already has repo write access via the SWE agent."
- Deliberately does not attempt to make Open WebUI itself session-aware for
  this case — if a future need calls for a richer, more general chat UI
  (multi-turn editing, attachments, etc.), that's a separate follow-up, not
  a reason to block this minimal page.
- `SESSION_PAGE_REDIS_URL` defaults to unset (in-memory) rather than
  reusing `identityLink.redisUrl` automatically, so enabling this feature
  never silently depends on a Redis instance a deployer didn't opt into.
