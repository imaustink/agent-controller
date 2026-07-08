# 0006: Consumer-facing HTTP interface, asynchronous accept/poll, on its own port

**Status:** accepted

## Context

The orchestrator needed a way for consumers to actually call it — the first
implementation pass ([ADR 0001](0001-parent-orchestrator-as-container.md)
through [0005](0005-kubernetes-client-node-job-launcher.md)) only wired a
one-shot CLI entry point (`node dist/index.js "<request>"`), not a real
request-handling surface, even though the orchestrator was always designed to
be a long-lived service. Two questions needed resolving to close that gap.

**Should the orchestrator run as a k8s Job, like the tools it launches?** No —
this isn't actually a new decision, just a re-confirmation of ADR 0001: the
orchestrator is explicitly the long-lived counterpart to the ephemeral Jobs it
launches. Jobs are for on-demand, run-to-completion tool/sub-agent work; the
orchestrator itself is a persistent Deployment-style process that many
requests flow through over its lifetime.

**What should the consumer-facing protocol be?** The orchestrator's
`launchJob` step blocks on the launched tool Job's terminal callback event
(docs/orchestrator.md#4-kubernetes-job-launcher), which can take minutes for
slow tools (e.g. `recipe-scraper` transcribing a long video). Options
considered for exposing that to a consumer over HTTP:

- **Synchronous** (`POST /invoke` blocks until the tool Job finishes) —
  simplest client contract, but holds an HTTP connection open for the
  duration of an arbitrary tool call; long calls risk hitting client/proxy/
  load-balancer timeouts, and it doesn't compose with a future multi-step/
  sub-agent flow that could take even longer.
- **Webhook** (`POST /invoke` accepts a caller-supplied callback URL, posts
  the result there when done) — mirrors the existing Job → orchestrator
  callback protocol, but a *caller-supplied* URL is a new SSRF/exfiltration
  surface pointed at whatever network the orchestrator can reach — exactly
  the class of risk this repo already treats seriously elsewhere
  (docs/security.md). Not worth introducing without an explicit need.
- **Asynchronous accept/poll** (`POST /invoke` returns `202 { id }`
  immediately; `GET /invoke/:id` polls for the result) — chosen. No new
  outbound-request surface, no timeout coupling to tool latency, and it's a
  natural fit given the orchestrator already tracks work by an internal id
  (the callback `job_id`) and already has an async, event-based mental model
  internally (docs/messaging.md).

**Which port?** The orchestrator already runs one HTTP listener
(`CallbackReceiver`, Job → orchestrator results). The new consumer-facing
listener runs on a **separate port** (`AGENT_HTTP_PORT`, distinct from
`AGENT_CALLBACK_PORT`) rather than sharing one, so the two can be exposed
differently at the network level: the invoke port to whoever is allowed to
call the agent, the callback port only to Job pods in-cluster.

## Decision

`apps/agent-orchestrator` runs as a long-lived process (unchanged from ADR
0001) exposing two independent HTTP listeners:

- `InvokeServer` (`AGENT_HTTP_PORT`, default 8081) — consumer-facing.
  `POST /invoke` (body `{ "request": string }`, `Authorization: Bearer
  <token>`) returns `202 { id, status: "pending" }` immediately; `GET
  /invoke/:id` returns the current `{ status: "pending" | "succeeded" |
  "failed", result?, error? }`. Invocation state is tracked in-memory only for
  now (see the app's README known gaps).
- `CallbackReceiver` (`AGENT_CALLBACK_PORT`, default 8080) — unchanged,
  internal-only Job → orchestrator result channel.

Authorization is resolved exactly once, inside the agent graph's
`resolveIdentity` node ([ADR 0004](0004-rbac-scoped-dynamic-tool-discovery.md)) —
`InvokeServer` only extracts the bearer token from the request and passes it
through, rather than re-implementing any auth logic at the HTTP layer.

## Consequences

- `index.ts` is now a persistent service (starts both listeners, handles
  `SIGTERM`/`SIGINT` for graceful shutdown) instead of a one-shot CLI; the
  old per-invocation process exit codes are gone — a non-zero exit now only
  signals a *startup* failure, and per-request outcomes are reported via
  `GET /invoke/:id` instead.
- Consumers must poll (or a future iteration could add Server-Sent Events /
  WebSocket streaming of the underlying `accepted → progress* →
  succeeded|failed` event stream — not implemented yet).
- In-memory-only invocation tracking means state is lost on restart and
  doesn't scale past one replica; a shared store (e.g. Redis/Postgres) is a
  follow-up if/when the orchestrator needs to run with more than one replica.
- Two ports instead of one adds a small amount of deployment surface (two
  Service entries / two NetworkPolicy rules instead of one) in exchange for a
  cleaner exposure boundary between "anyone allowed to call the agent" and
  "only Job pods in this cluster."
