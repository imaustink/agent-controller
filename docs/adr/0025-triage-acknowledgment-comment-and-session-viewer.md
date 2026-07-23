# 0025. Upfront triage acknowledgment comment + session-viewer page

Status: accepted

## Context

ADR 0024 made the `issues.labeled` trigger deterministic (bypasses RAG
retrieval, dispatches straight to `opencode-swe-agent`), but the *observable*
behavior from a human's point of view is still: apply the label, then wait —
silently, for however long `opencode-swe-agent`'s Job takes (potentially
several minutes) — until exactly one reply comment lands (`relayAndReply`,
`apps/integration-gateway/src/server.ts`), either a clarifying question or
the final result. Two problems fall out of that:

1. **No acknowledgment.** Nothing tells the requester the label was even
   seen and understood before the (possibly long) work starts. A missed
   webhook, a misconfigured trigger label, or a slow Job all look identical
   from the issue: silence.
2. **No visibility into an in-progress run.** The only way to see what the
   agent is doing *while* it works is `kubectl logs`/`describe` on the
   `AgentRun`'s Job (ADR 0023's session-id annotation was explicitly framed
   as a building block for exactly this, but nothing consumed it yet) — not
   realistic for the person who applied the label, and no way to steer the
   agent (send it another instruction) without waiting for its final reply
   and leaving a follow-up issue comment.

## Decision

**Upfront comment, posted before the orchestrator turn even starts.**
`GatewayServer`'s `issues.labeled` handler (`apps/integration-gateway/
src/server.ts`) now calls a new `startTriage` method instead of going
straight to `relayAndReply`: it posts a short "I'm starting to look into
this" comment first (`postStartingWorkComment`), then proceeds exactly as
`relayAndReply` always has. A failure posting this comment (e.g. a
transient GitHub API blip) is logged, never blocks the actual triage work.
This is deliberately generic ("starting… I'll follow up with a question or
the result") rather than trying to predict whether the agent will ask a
clarifying question — that decision still isn't made until
`agent-orchestrator`'s existing RAG/`checkActiveAgentRun` machinery actually
runs; nothing about that decision path changes.

**A session-viewer page**, linked from that same comment when configured.
`integration-gateway` is the only internet-reachable piece of this system
(`docs/integrations-gateway.md`), so it hosts the page itself
(`GET /sessions/:sessionId`, `POST /sessions/:sessionId/messages`,
`apps/integration-gateway/src/session-viewer.ts` +
`server.ts`'s handlers), proxying the underlying data from a new read-only
`GET /sessions/:sessionId` on `agent-orchestrator`'s `InvokeServer`
(`apps/agent-orchestrator/src/server.ts`) via
`OrchestratorClient.getSession` — the same service-to-service bearer token
the gateway already authenticates its `/invoke` calls with. Not internet-
facing itself (agent-orchestrator's invoke port is cluster-internal, same
as today).

- **Transcript**: `SessionRecord` (`apps/agent-orchestrator/src/session/
  types.ts`) gains an optional `transcript` field — a small, capped
  (`MAX_TRANSCRIPT_ENTRIES` = 20), best-effort rolling history of each
  turn's request/response text, appended by `persistSession` alongside its
  existing skill/agent/continuation bookkeeping. Same "never
  correctness-critical" discipline as every other `SessionRecord` field:
  losing it (restart, TTL, eviction) only degrades what the viewer can
  show, never orchestrator behavior.
- **Pending flag**: a new in-memory `pendingInvokeSessions` set on
  `InvokeServer` marks a session "still working" for the duration of a
  fire-and-forget `/invoke` turn — purely a display hint, never persisted.
- **Capability token, not a stored session/auth model.** A GitHub issue —
  and therefore any link posted onto it — is often public, so the viewer
  link must be safe to leave in a public comment. Rather than a stored
  random token (which would require the link-poster and the link-verifier
  to share a datastore, or the token to be minted only after
  agent-orchestrator has created a `SessionRecord`, which it hasn't yet at
  the point the comment is posted), the token is an HMAC of the session id
  under a gateway-only secret (`GATEWAY_SESSION_VIEWER_SECRET`,
  `signSessionToken`/`verifySessionToken` in `session-viewer.ts`) —
  computable and verifiable statelessly, by this one process, at any time.
  This is a capability (whoever holds the link can view/post to that
  session), not an identity check — consistent with the fact that a public
  GitHub issue's comments are already visible/postable by anyone who can
  see the issue.
- **Sending another prompt reuses `relayAndReply` unchanged.** The viewer
  page's form `POST`s back to this same gateway
  (`handlePostSessionMessage`), which parses the session id back into
  `owner`/`repo`/`issueNumber` (`parseGithubSessionId`, the inverse of
  existing `sessionIdFor`) and calls `relayAndReply` exactly as if the text
  had been left as a new GitHub issue comment — including posting the
  eventual result back onto the issue. No parallel reply/session-continuity
  path was introduced; the viewer's textbox is just another way to talk to
  the same conversation.
- **Off by default.** Both `GATEWAY_SESSION_VIEWER_BASE_URL` and
  `GATEWAY_SESSION_VIEWER_SECRET` must be set together (same
  partial-config-fails-closed discipline as identity-link/orchestrator
  OIDC in `index.ts`) to enable the feature; absent config, the upfront
  comment is still posted (just without the link), and both routes 404 —
  existing deployments are unaffected.

## Consequences

- The requester on a triaged issue now sees an immediate acknowledgment
  instead of silence, and — when the session-viewer is configured — a link
  to watch the agent's transcript and nudge it without a full
  label/comment round-trip through GitHub.
- `agent-orchestrator`'s `GET /sessions/:sessionId` is a new read-only
  surface, but it's not internet-facing (only reachable from trusted
  in-cluster callers like `integration-gateway`, same posture as `/invoke`
  itself) and 404s entirely when no `SessionStore` is configured — no
  change to any deployment that doesn't already use session persistence.
- The upfront comment doubles the number of GitHub API calls per triage
  trigger (one acknowledgment, one final reply) — negligible compared to
  the GitHub REST API's rate limits for this traffic pattern (one issue
  label event, at most a handful of follow-ups).
- The capability-token model means anyone who can read the link (i.e.,
  anyone who could already read/comment on the issue, for a public repo)
  can also drive that session via the viewer's form — an intentional,
  documented tradeoff, not an oversight: it mirrors the trust level a
  public issue's comment section already has today, and the token grants
  no access beyond that one session.
- The session-viewer page and `GET /sessions/:sessionId` are additive: an
  existing deployment that never sets the two new env vars sees no
  behavior change at all beyond the new upfront comment.
