# 0017. Per-tool/per-agent continuation tokens live in the session store, not the chat transcript

Date: 2026-07-16

## Status

Accepted

## Context

Two workflows needed a piece of opaque state to survive from one turn to the
next, keyed to a single tool or agent:

- `recipe-publisher` needs the Mealie slug of a recipe it already published,
  so a follow-up edit updates that recipe instead of creating a new one.
- `opencode-swe-agent` (ADR 0013, ADR 0016) needs the repo/branch/PR/session
  of a coding task it already started, so a follow-up instruction continues
  the same branch instead of starting a new repository.

Both were solved the same way: embed the state as a leading HTML comment in
the tool/agent's own reply (`<!-- mealie-slug: ... -->`,
`<!-- swe: ... -->`), and rely on the orchestrator's conversation-history fold
(`apps/agent-orchestrator/src/openai/chat-completions.ts`) to hand it back on
the next turn as part of the user's message. This worked, but the marker sat
in the actual chat transcript — the same text the LLM planner and any other
skill logic reads. `docs/security.md` documented the resulting risk: a
sufficiently effective prompt injection earlier in the conversation could
cause the assistant to echo back a forged repo/branch or slug, and the
orchestrator would trust it. The blast radius was bounded (a GitHub App
installation's own repos; a caller's own Mealie instance) but it was a real,
documented attack surface, not a hypothetical one.

The orchestrator is otherwise stateless per request (ADR 0008) except for the
session store already introduced for skill continuity (ADR 0012) and now
backed by Redis for multi-replica deployments (`RedisSessionStore`). That
store is the natural place for this state instead.

## Decision

Generalize the *mechanism*, keep each tool/agent's *payload* opaque to the
orchestrator:

1. **Wire format is unchanged** — a leading `<!-- continuation: <token> -->`
   marker — but it now appears only in the ARGUMENT the orchestrator hands a
   tool/agent, and in that tool/agent's own SUCCESS output, never in the
   text a user or the LLM planner ever reads:
   - `graph.ts`'s `runTool` strips this marker from a string tool result via
     `extractContinuationToken` before the result reaches `composeResponse`,
     the caller, or the next turn's transcript, and stashes the token in
     `state.extractedContinuation`. On the next call to the SAME tool, it
     re-prepends the saved token onto `tool_args` via `prependContinuationToken`
     (`apps/agent-orchestrator/src/continuation.ts`).
   - `recipe-publisher` was already speaking this wire format (see
     `tools/recipe-publisher/src/mealie/markdown-parser.ts`); only the
     orchestrator-side plumbing was missing.
2. **Agents get an equivalent, but via a cleaner channel.** An `AgentRun`
   episode is a fresh Job/process each time (ADR 0013), so its "reply" already
   carries a structured, out-of-band `result` field alongside the chat
   `message` (`packages/messaging/src/agent-protocol.ts`'s `reply.result`,
   `AgentReply.result` in `@controller-agent/agent-runtime`) — a side channel
   the chat transcript never sees. `opencode-swe-agent` now returns
   `{ message, result: encodeSweContinuation(marker) }` instead of embedding a
   `<!-- swe: ... -->` marker in `message`. `graph.ts`'s `delegateToAgent` (and
   `checkActiveAgentRun`, for an episode that concludes mid-HITL) reads a
   FINAL reply's `result` into `state.extractedAgentContinuation`, and prepends
   any saved token onto the goal of the NEXT episode for that same agent using
   the same `<!-- continuation: ... -->` wire format as tools (duplicated as a
   small local parser in `apps/opencode-swe-agent/src/continuation.ts`, since
   that app ships as its own container image with no access to the
   orchestrator's source).
3. **Storage**: `SessionRecord` gains `toolContinuations` and
   `agentContinuations`, both `Record<toolOrAgentId, opaqueToken>`. The
   orchestrator never parses either value — each tool/agent encodes and
   decodes its own state. `InvokeServer.persistSession` re-fetches the
   existing record before writing (the store is get/set, not patch) so one
   tool's/agent's token is never clobbered by another's turn. An empty-string
   token clears the entry for that id (the tool/agent ran but returned no
   marker this time).
4. The `docs/adr/0015` design (composer receives the tool's raw output
   including any marker) still holds structurally, but the marker itself is
   gone by the time `composeResponse` sees the result — it never survives
   into the narration/next-turn-detection surface at all, which is strictly
   safer than "survives verbatim."

## Consequences

- Neither `<!-- mealie-slug: ... -->` nor `<!-- swe: ... -->` appears in a
  chat transcript anymore. The prompt-injection surface `docs/security.md`
  documented for the swe marker is closed: continuation state now only ever
  passes through the session store and the tool/agent's own success payload,
  never through anything an LLM reads or writes.
- `SessionStore` (`InMemorySessionStore`, `RedisSessionStore`) needed no
  changes — both already round-trip an arbitrary `SessionRecord`.
- `AgentTurnResult.result` / `AgentReply.result` were already part of the
  agent protocol (unused by any consumer) — this is the first thing to
  actually populate them.
- A tool/agent that stops emitting a continuation marker on success now
  actively clears the stored token (empty-string convention) rather than
  leaving a stale one in place indefinitely.
