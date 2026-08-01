# 0035. Caller-supplied tools over the OpenAI facade — JIT-vectorized, cached, skill-gated

Status: accepted

## Context

Two levels of tool calling exist today, both sourced entirely from the
in-cluster CRD catalog:

1. **The orchestrator's own planner loop** — a Skill's `toolRefs`/`agentRefs`
   (ADR 0008, ADR 0021) resolved by `loadSkillTools` and dispatched by
   `planAction`/`runTool`.
2. **A sub-agent's internal loop** — an Agent's `toolRefs` (ADR 0028) reached
   from `AgentSession.callTool()` over the NATS `tool_call`/`tool_result` pair.

Both share the property that the orchestrator (or the controller it delegates
to) *executes* the tool, and that every callable tool is a `Tool`/`LocalTool`
CR that was embedded into the `tools` Qdrant collection at startup and kept
current by a watch (ADR 0010, ADR 0020).

What's missing is the third level the OpenAI wire format assumes: a **consumer
passing its own tools in the request**. `POST /v1/chat/completions` (ADR 0007)
accepts `tools: [{type: "function", function: {name, description, parameters}}]`
in every standard client, and every standard client expects to get
`tool_calls` back, run the function itself, and resend the conversation with
`role: "tool"` results appended. Today the orchestrator silently ignores the
field: a client that offers tools gets a prose answer that never calls them,
with no signal that its tools were dropped. Open WebUI's native tool calling,
LibreChat, and anything built on the OpenAI SDK all sit on this contract.

Naively supporting it would damage the two existing levels, which is the whole
difficulty:

- **Context pollution.** A client may send dozens of tool definitions (Open
  WebUI pointed at a populated tool server routinely sends 30–80). Splicing all
  of them into the action planner's prompt drowns the Skill's own 1–5 declared
  tools in caller-supplied noise, and degrades the very selection quality the
  two-layer retrieval of ADR 0008 exists to protect.
- **Catalog contamination.** Upserting caller tools into the `tools`
  collection would put one caller's ephemeral, unauthorized function
  definitions into the retrieval candidate set for *every other* caller, for
  `selectFallbackTool`'s catalog-wide query, and for sub-agent `toolRefs`
  resolution. It would also grow and churn the collection the catalog's own
  recall depends on.
- **Latency.** Embedding N tool descriptions on every turn adds N embedding
  round trips to the hot path of a request that may not use a caller tool at
  all.
- **Trust.** A `Tool` CR description is semi-trusted (authored by whoever owns
  that tool, per security.md). A caller tool's `name`, `description`, and JSON
  Schema are fully **untrusted** — supplied per-request by whoever holds a
  bearer token — yet they must reach an LLM prompt to be selectable at all.

## Decision

### 1. The client executes; the turn suspends

Caller tools follow the standard OpenAI round trip rather than being executed
by the orchestrator. On choosing one, the graph sets `pendingToolCalls` and
ends the turn; the facade renders them as `choices[0].message.tool_calls` with
`finish_reason: "tool_calls"`, and the client runs the function and resends the
conversation with `role: "tool"` messages appended.

The rejected alternative was letting a caller tool definition carry an endpoint
the orchestrator calls itself. That would finish a turn in one round trip, but
no off-the-shelf OpenAI client populates such a field (so it buys nothing for
the ecosystem this ADR exists to serve), and it would put caller-controlled
egress inside the orchestrator pod — the pod that holds the k8s identity,
directly against the blast-radius reasoning in orchestrator.md.

Because the orchestrator has no conversation store (ADR 0007/0012's standing
gap), resumption is **read off the wire, not the session**:
`buildAgentRequest` now parses `assistant.tool_calls` + the matching
`role: "tool"` messages out of the incoming `messages` array and returns them
as structured prior-call history, which seeds `AgentState.actionHistory`. The
existing `MAX_TOOL_STEPS` check in `planAction` counts `actionHistory.length`,
so seeding it bounds the resumed loop for free — a client cannot drive an
unbounded planner loop by resending. The conversation's active skill still
continues via the ordinary ADR 0012 session mechanism, so the resumed turn
re-enters the same skill with the same declared tools.

Two properties of this parsing matter. Prior tool results were previously
**dropped entirely** — `buildAgentRequest` only ever kept `user`/`assistant`
messages — so without this change a client's tool result would vanish and the
planner would re-issue the same call forever. And an `assistant` message
carrying *only* `tool_calls` has `content: null`, which the existing
history-folding loop skips; the call/result pair is therefore lifted into
structured history rather than stringified into `<conversation_history>`, which
keeps the planner reading it as a tool result instead of as conversation prose.

### 2. Own collection, keyed by content hash — the collection *is* the cache

A separate Qdrant collection (`caller_tools`, `AGENT_QDRANT_CALLER_TOOL_COLLECTION`)
behind a `CallerToolStore` port, same `Embedder` and vector size as the rest.
Nothing about the `tools`/`skills`/`agents` collections changes, so catalog
recall and latency are untouched by construction rather than by discipline.

The point id is a **sha256 of the normalized definition** (name + description +
canonicalized JSON Schema), not a per-caller or per-session id. Consequences:

- Identical definitions embed **once, ever**, across all callers and all turns.
  Since a given client sends a near-identical tool array on every single turn,
  the steady-state embedding cost of this feature is zero. This is what makes
  "vectorize just in time" affordable: the JIT cost is paid on first sight of a
  definition, not per request.
- Per-turn flow: hash this request's tools → `retrieve` those ids to see which
  are already present → embed + upsert **only the misses** → similarity-search
  restricted to this request's own id set.
- Restricting the search to ids taken from the request body means cross-caller
  leakage is structurally impossible — retrieval never ranges over definitions
  this request didn't itself supply. That is why the collection needs no RBAC
  payload filter, unlike every other store in this codebase: the authorization
  question ("may this caller use this tool?") is vacuous for a tool the caller
  both supplied and will execute themselves, in their own process, under their
  own credentials. The orchestrator never gains a capability here; it only
  learns that the caller has one.

Content-hash keying does mean a shared cache is a shared *namespace*: a caller
learns nothing (they can only retrieve by hashes they already computed from
definitions they already hold), but two callers using the same definition share
one point. A `lastSeenAt` payload field plus a periodic `prune()` sweep
(Qdrant has no native TTL) keeps abandoned definitions from growing the
collection forever.

### 3. Pruning to top-K, and skipping the store entirely when small

Only the top-K caller tools (`AGENT_CALLER_TOOL_TOP_K`, default 5) by
similarity to the request ever reach the planner prompt — the same discipline
ADR 0008 applies to the catalog, for the same reason.

**When the caller sent ≤ K tools, the store is not consulted at all.** There is
nothing to prune, so the vector round trip (and any embedding) would be pure
overhead. This keeps the common case — a handful of tools — at exactly today's
cost, and confines all JIT vectorization to the case that actually motivates
it: a caller with a large tool array. Hard caps on tool count and on
description/schema size reject abuse with an OpenAI-shaped `400` rather than
silently truncating.

### 4. Skill-gated, additive

Retrieved caller tools are **appended** to whatever the selected Skill already
declared, so an authored procedure can use a caller tool (e.g. a skill that
writes a document, calling the client's own `save_file`). They are also
considered on the no-match fallback path, where there is no skill to gate.

`Skill.spec.allowCallerTools` (`*bool`, **nil ⇒ allowed**) lets a sensitive
authored skill refuse them. Opt-out rather than opt-in because the default that
matches the wire contract is "the tools I sent are usable"; a skill whose
markdown encodes an exact, auditable procedure is the exception that turns it
off. The pointer type is what makes nil-means-allowed expressible — a plain
`bool` would make Go's zero value silently mean "refuse".

The gate is *not* an authorization boundary and is not treated as one: it keeps
an authored skill's tool loop predictable, nothing more. The real reason no
RBAC applies is §2's — the caller executes their own tool.

Caller tools are marked on `ToolDescriptor` with a `callerTool` field, joining
`jobTemplate`/`localExec`/`agentRunTemplate` as a fourth mutually-exclusive
dispatch kind. This is deliberate: `planAction` re-validates the planner's
chosen id against `skillTools` exactly as before, and `runTool` gains one more
branch — the only branch that *doesn't execute anything*. Ids are namespaced
`caller:<name>`, so a caller tool can never collide with or shadow a `Tool` CR
id, and the planner's re-validation cannot be tricked into resolving a caller
name to a catalog tool.

### 5. Untrusted at the prompt, and never on the housekeeping path

Caller tool names/descriptions/schemas are rendered into the planner prompt
inside a distinctly-labeled untrusted block, one trust level below a `Tool` CR
description (semi-trusted) and two below Skill markdown (trusted). The planner
already may not invent tool ids and is already re-validated against the
resolved list, so a hostile description's ceiling is "gets itself selected" —
which for a caller tool means the caller's own client is asked to run the
caller's own function.

Open WebUI's internal housekeeping completions (title/tag/query generation)
arrive at the same endpoint and are short-circuited by
`isInternalUiTaskRequest` *before* the graph is ever invoked (ADR 0007's
follow-up), so they can never emit `tool_calls`. That ordering is now
load-bearing and covered by a test: a title-generation request that happens to
carry a client's tool array must return prose, never a tool call the client
would then execute as a side effect of rendering a chat title.

`tool_choice` is honored as `"none"` (drop caller tools entirely), absent /
`"auto"` (default), and a specific `{type: "function", function: {name}}`
(pass only that one, bypassing retrieval). `"required"` becomes a strong
directive to the planner rather than a hard constraint — the planner is our own
Structured-Outputs call and may still legitimately conclude no tool fits, and
lying about a guarantee we don't enforce is worse than documenting the gap.

## Consequences

- Any OpenAI-compatible client can offer its own tools to the agent and have
  them selected alongside the in-cluster catalog, with no CRD authoring and no
  deployment change.
- The two existing tool levels are unchanged: no new writes to the catalog
  collections, no new candidates in `selectFallbackTool`'s catalog query, and
  no path from a caller tool into a sub-agent's `toolRefs` dispatch.
- Steady-state embedding cost is zero (content-hash cache), and zero round
  trips at all for callers sending ≤ K tools.
- A turn that ends in `tool_calls` is a real terminal state for the graph,
  which now has two non-error terminal shapes (`result` vs.
  `pendingToolCalls`). Both consumer-facing protocols must render it —
  `/v1/chat/completions` in both streaming and blocking modes, and `/invoke`'s
  polled record — which is the two-call-sites-to-update cost ADR 0007 already
  called out, now paid a second time.
- `buildAgentRequest`'s signature changes from `string | undefined` to a
  `{request, priorToolCalls}` object; two call sites in `server.ts` update.
- The caller-tool collection is a shared namespace across callers by content
  hash. This is safe (retrieval is id-restricted to the request's own set) but
  is a genuine departure from the RBAC-filtered discipline every other store
  follows, and is the design's least conventional decision.
- `"required"` tool choice is advisory, and per-*conversation* loop bounding
  remains unenforced (a client may always resend); only the per-turn planner
  loop is capped, same as before this ADR.
- Caller tools are reachable only from the orchestrator's own planner loop —
  not from a sub-agent's internal loop (ADR 0028). A sub-agent has no channel
  back to the original HTTP caller's client, so there is nowhere to send a
  `tool_call` that the consumer would execute. Out of scope, same shape as ADR
  0028's own scope cut.
