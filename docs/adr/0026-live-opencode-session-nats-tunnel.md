# 0026. Live opencode session, tunneled over the existing NATS channel

Status: accepted

## Context

ADR 0025 gave the triage flow a session page for watching turn history and
sending follow-up prompts, but each prompt there is relayed into
`agent-orchestrator`'s conversational `/invoke` turn — a fresh RAG turn each
time, not the actual running `opencode-swe-agent` process. The real ask is
to interact with the **live opencode CLI session**: see its genuine event
stream (message deltas, tool calls, permission requests) and send it
prompts directly while it's running, not just queue another turn for
whenever a Job eventually gets around to it.

Two things make this newly tractable:

1. **`opencode serve` exists.** Confirmed directly (`npx opencode-ai@latest
   serve` + its `/doc` OpenAPI spec): it's a genuine headless REST+SSE
   server — `POST /session`, `POST /session/{id}/prompt_async`,
   `GET /event` (SSE), permission request/reply endpoints, session
   history — everything a live view needs. `apps/opencode-swe-agent` today
   only ever invokes the one-shot, non-interactive `opencode run` CLI
   (`src/opencode.ts`) and exits after a single turn.
2. **The NATS channel between an agent Job and `agent-orchestrator` is
   already a live, bidirectional, cluster-boundary-crossing pipe**
   (`packages/messaging/src/agent-protocol.ts`, one subject pair per
   `AgentRun`). It already carries incremental `progress` narration and a
   `prompt`/non-final-`reply` HITL loop for the life of a Job.

We considered exposing `opencode serve` over a real network path instead:
a container port + a Kubernetes Service on the `AgentRun`'s Job, a new
CRD field, Go controller logic to own that Service, new core-controller
RBAC, a new `NetworkPolicy` scoping ingress to `agent-orchestrator`'s pods,
and a minted per-run Basic Auth password/Secret so `agent-orchestrator`
could reverse-proxy straight to the Pod. Rejected for this iteration: it's
a materially bigger, higher-risk build touching Go CRD/controller/RBAC/
NetworkPolicy in addition to the TypeScript apps, for the same end
capability the existing NATS channel can already carry. Tunneling over
NATS reuses a trust boundary that already exists and ships in one
language layer (TypeScript) instead of two.

## Decision

**Extend the existing agent protocol** (`packages/messaging/src/
agent-protocol.ts`), fully backward compatible — every new variant is
additive to the discriminated unions, nothing existing changes shape:

- up (agent → orchestrator): `opencode_event` (one raw SSE event from the
  agent's local opencode server, forwarded verbatim), `opencode_response`
  (reply to a forwarded request, correlated by `requestId`), `session_idle`
  (the agent has sent its final `reply` but is staying resident/tunnelable
  until `liveUntil`), `session_ended` (the agent is about to exit).
- down (orchestrator → agent): `opencode_request` (forward an HTTP call —
  method/path/body — into the agent's local opencode server).

**`apps/opencode-swe-agent` becomes long-lived**, bypassing `runAgent()`
(whose contract is deliberately "one goal in, one reply out, then exit" —
generalizing that would ripple into every other agent using
`packages/agent-runtime`). Instead it drives the lower-level primitives
`runAgent` itself is built on (`loadConfig()` + `NatsChannel.connect()`,
both already exported) directly:

1. Spawn `opencode serve --hostname 127.0.0.1 --port <fixed>` as a
   background process — **loopback-only inside the Pod's own network
   namespace, never exposed on the network**, plus a locally-generated
   `OPENCODE_SERVER_PASSWORD` as cheap defense-in-depth.
2. Create/continue a session via its REST API, submit the goal, and
   forward its `GET /event` SSE stream onto NATS as `opencode_event`
   up-messages.
3. Handle `opencode_request` down-messages by proxying a local `fetch`
   against the opencode server and replying with `opencode_response`.
4. On task completion, publish the **exact same `reply` (final: true,
   `result` = the `SweMarker` continuation token) contract as today** — the
   issue comment and next-turn continuation-token handoff (ADR 0017) are
   completely unaffected by any of this.
5. Rather than exiting immediately after that final reply, stay resident
   for a configurable idle window (`session_idle`, `liveUntil`), continuing
   to serve `opencode_event`/`opencode_request` traffic, before finally
   publishing `session_ended` and exiting. Still hard-capped by the Job's
   existing `TimeoutSeconds`.

**`agent-orchestrator`** gains: a `lastAgentRunId` field on `SessionRecord`
(`session/types.ts`) — kept even after `activeAgentRunId` is cleared on a
final reply, deliberately separate from it (which keeps its exact current
meaning for graph routing/continuation logic) and used for nothing but
"which run id should a live viewer probe"; a long-lived NATS subscription
(`subscribeLive`) and a request/response forwarder
(`forwardOpencodeRequest`) alongside `NatsAgentChannel`; and three new
routes on the existing bearer-gated invoke-port server — no new Service or
port — `GET /sessions/live?sessionId=...`, `GET /agent-runs/:runId/events`
(SSE), `POST /agent-runs/:runId/opencode` (`sessionId` travels as a query
param on all three since it commonly contains `#`/`/`).

Liveness itself is answered by a **real-time round trip**, not a cached
flag: `GET /sessions/live` forwards a cheap `GET /global/health` through
`forwardOpencodeRequest` and reports `live` based on whether that actually
succeeds within a couple seconds. Considered instead: threading a
`session_idle` up-message's `liveUntil` timestamp through `awaitReply`
(caching "should still be live until this time" on the session record).
Rejected — LangGraph's `AgentState` and both of `server.ts`'s consumption
paths (blocking `/invoke` and the streaming chat-completions facade) would
need a new field threaded through just to carry a timestamp that could go
stale anyway if the Pod crashed or was evicted without a clean
`session_ended`. The live probe is simpler (no graph changes at all) and
self-correcting.

**`integration-gateway`'s session page** (ADR 0025) checks live status on
load; when live, it renders the streamed events and posts prompts straight
into the live session instead of `/invoke`; otherwise it falls back to
ADR 0025's exact turn-history behavior unchanged.

## Consequences

- Zero new network attack surface: `opencode serve` never leaves
  `127.0.0.1`; every hop crosses the cluster boundary over the same NATS
  subject pair that already exists and is already trusted for `progress`/
  `prompt`/`reply`.
- No Go/CRD/RBAC/NetworkPolicy changes — the entire feature lives in
  `packages/messaging` and three TypeScript apps.
- Fully additive: anyone who never opens the live page gets `opencode-swe-agent`'s
  exact pre-existing behavior (final reply → issue comment → continuation
  token → fresh Job next time); the only observable difference is the Pod
  stays up a bit longer after finishing, bounded by the idle timeout.
- `opencode-swe-agent`'s Agent CR needs a larger `TimeoutSeconds` default
  than before (task time + idle window, not just task time), since the Pod
  is no longer done the instant the coding task is.
- `activeAgentRunId` (graph routing/continuation semantics) and
  `lastAgentRunId` (a live viewer's only hint of which run id to probe) are
  deliberately independent fields — conflating them would let a live-page
  implementation detail leak into and change the orchestrator's existing,
  already-shipped conversational-continuation behavior.
- If a future need calls for driving other agents' local servers over this
  same tunnel, the `opencode_event`/`opencode_request` message shapes are
  opencode-specific by name but structurally generic (raw event passthrough,
  method/path/body request forwarding) — reusable without a protocol change.
