# 0007: OpenAI Chat Completions-compatible facade (`/v1/models`, `/v1/chat/completions`)

**Status:** accepted

## Context

Consumer-facing access to the orchestrator ([ADR 0006](0006-async-http-invoke-interface.md))
is a bespoke accept/poll API (`POST /invoke`, `GET /invoke/:id`). That's the
right *native* contract for programmatic callers, but it means the agent
can't be pointed at for free from the large ecosystem of chat UIs that speak
OpenAI's API (Open WebUI, LibreChat, and similar) — those tools expect
`GET /v1/models` and `POST /v1/chat/completions`, not a custom shape.

A few things about that ecosystem's contract don't map cleanly onto this
agent, and had to be resolved rather than glossed over:

- **Blocking vs. streaming.** ADR 0006 specifically avoided a blocking
  request/response because `launchJob` can take minutes. OpenAI's API
  supports both `stream: false` (blocking) and `stream: true` (Server-Sent
  Events). Dropping blocking support entirely would break clients that don't
  stream; supporting only blocking would reintroduce the exact timeout risk
  ADR 0006 avoided. **Decision: support both**, and lean on streaming as the
  better-fitting default — SSE turns out to be a *better* fit than plain
  accept/poll for this specific consumer type, because progress can be
  narrated as chat deltas while the underlying job runs, and the open
  connection doesn't go idle (see below), unlike a plain blocking call.
- **Multi-turn `messages` vs. a single `request` string.** The agent graph has
  no conversation memory — one request in, one Job launch out. Silently
  faking multi-turn memory would be dishonest about a real gap. **Decision:**
  take the most recent `user` message and ignore earlier turns; this is
  documented as a known gap (see the app's README), not hidden behind the
  OpenAI-shaped wire format.
- **Structured JSON results vs. chat prose.** Tools return structured JSON
  (e.g. a `Recipe` object), not natural-language prose. **Decision:** render
  non-string results as a fenced ```json``` block in the assistant message
  rather than inventing a summarization step — honest about what the data
  is, still readable in a chat UI.
- **Where progress narration comes from.** The launched tool Job's own
  internal stages (e.g. recipe-scraper's extract/transcribe) aren't
  observable outside the Job → orchestrator callback protocol, and
  `CallbackReceiver` only exposes the terminal event today (ADR 0006).
  Rather than plumbing intermediate tool-internal events through a new
  channel, streaming narrates **agent graph node transitions** instead
  (resolveIdentity → retrieveTools → selectTool → launchJob), using
  LangGraph's built-in `stream(..., { streamMode: "updates" })`, which yields
  `{ [nodeName]: <partial state update> }` after each node runs. This is a
  real, mechanically-verified signal (not synthetic keep-alive filler) and
  needs no new plumbing — but it means the *last* step (`launchJob`, which
  blocks on the Job's full duration) still has a gap with no fine-grained
  progress inside it. A periodic SSE comment-line heartbeat (`: keep-alive`)
  fills that gap so the connection doesn't go idle, without pretending to
  have progress data that doesn't exist. Streaming true tool-internal stages
  is a documented follow-up, not implemented here.
- **Error reporting differs by mode.** For `stream: false`, headers aren't
  sent until the graph settles, so a failure can still be reported as a
  proper HTTP error status with OpenAI's `{ error: { message, type, code } }`
  shape. For `stream: true`, the `200` + SSE headers are already flushed
  before the graph could possibly have failed, so a failure is instead
  rendered as the final assistant message content (prefixed `❌`) — there's no
  way to retroactively change the HTTP status of an already-open SSE stream.
- **Auth.** OpenAI clients send `Authorization: Bearer <api-key>` — this
  needed no new design: it's exactly the existing bearer-token passthrough to
  the graph's `resolveIdentity` node (ADR 0004). The chat-completions handler
  extracts the header and forwards it; it does not re-implement or duplicate
  any authorization logic.

## Decision

Add `GET /v1/models` and `POST /v1/chat/completions` to the same
`InvokeServer` (same port as `/invoke`, per ADR 0006's reasoning — both are
"consumer-facing", as opposed to the Job-callback port). This is purely an
additive translation layer (`src/openai/*.ts`) in front of the existing
`buildAgentGraph` — the graph itself is unchanged, and `/invoke` +
`GET /invoke/:id` continue to work exactly as before for programmatic
callers.

## Consequences

- Any OpenAI-API-compatible chat UI can point at the orchestrator as if it
  were a model endpoint, by setting its "API base URL" to this service and
  picking the one advertised model id (`agent-orchestrator`).
- Two consumer-facing protocols now need to be kept in sync with the agent
  graph's actual state shape (`AgentState`) — `/invoke`'s polling shape and
  the OpenAI adapter's chunk/response shape. Both are thin (no business
  logic duplicated), but it's still two call sites to update if `AgentState`
  changes.
- `AgentGraphLike` (the interface `InvokeServer` depends on) grew a `stream`
  method alongside `invoke`; both are satisfied structurally by LangGraph's
  compiled graph, so `index.ts` didn't need to change beyond passing the same
  graph instance to `InvokeServer`.
- No token accounting is implemented (`usage` is zeroed in non-streaming
  responses) since no single component tokenizes the whole pipeline — clients
  that rely on real usage numbers for cost tracking won't get them.
- Conversation memory, tool-internal progress narration, and true streaming
  of a launched tool's own stages remain explicitly out of scope (tracked as
  known gaps in the app README, consistent with how earlier stubs like
  `StaticIdentityResolver` are called out rather than silently accepted as
  "done").
