# 0028. `Agent.spec.toolRefs` — sub-agents call Tools through the agent-runtime SDK

Status: accepted

## Context

Every Tool-calling loop that exists today lives in the PARENT orchestrator's
own graph (`agent/graph.ts`): a Skill's `toolRefs`/`agentRefs` (ADR 0008, ADR
0021) are resolved and dispatched by the orchestrator's `planAction`/`runTool`
nodes, never by the sub-agent process itself. A sub-agent launched as an
`AgentRun` Job (`packages/agent-runtime`'s `runAgent(handler)` contract) can
narrate progress, ask the user a question, and reply — but has no way to call
a `Tool` CR from within its own internal loop. `AgentSpec` has `skillRefs`
(markdown the agent may load into its own prompt) but nothing analogous for
Tools.

`claude-code-swe-agent`/`opencode-swe-agent` don't need this (their "tools"
are the coding CLI's own built-ins: bash, git, file edits). But a sub-agent
built directly on `packages/agent-runtime` — a generic reasoning loop that
isn't wrapping an existing coding CLI — has no way to reach the same `Tool`
catalog (`kubectl-readonly`, `web-fetch`, `web-search`, a recipe tool, ...)
that the parent orchestrator's Skills already call, short of reimplementing
each tool's container/execution logic itself.

## Decision

**`AgentSpec.ToolRefs []string`** (`controllers/core-controller/api/v1alpha1/agent_types.go`)
names `Tool` CRs (same namespace) this Agent's OWN internal loop may call —
mirrors `Skill.spec.toolRefs` exactly, but scopes the sub-agent's capability
list instead of the orchestrator's. `AgentReconciler` validates the refs
resolve to existing `Tool` CRs, folded into the same `Ready` condition as the
existing `serviceAccount`/`skillRefs` checks (new `ToolRefsMissing` reason
alongside `ServiceAccountMissing`/`SkillRefsMissing`). Like every other refs
check in this codebase, this is a static-config sanity check, not the
authorization boundary itself — the live `tool_call` handler below
re-validates against `toolRefs` at call time regardless of CRD status.

**Protocol** (`packages/messaging/src/agent-protocol.ts`): two new messages,
same request/response shape as the existing `opencode_request`/
`opencode_response` pair (ADR 0026) but for tool calls instead of live-session
HTTP forwarding:

- up (agent -> orchestrator): `tool_call { callId, tool, input }`
- down (orchestrator -> agent): `tool_result { callId, ok, result?, error? }`

Correlated by `callId`, not by a fixed one-in-flight-at-a-time slot (unlike
`ask()`/`pendingAsk`) — an agent may have more than one call outstanding.

**SDK** (`packages/agent-runtime`): `AgentSession.callTool(name, input):
Promise<unknown>` publishes `tool_call` and resolves/rejects off a
`callId`-keyed pending map, exactly like `ask()` resolves off `pendingAsk` but
without the single-slot restriction. Resolves with the tool's raw result on
`ok: true`; throws `ToolCallError` on `ok: false`; rejects with the same
`CancelledError` as `ask()` if the run is cancelled while a call is
outstanding. This is the "abstract it away in the SDK" ask from the issue —
the agent author writes `await session.callTool("kubectl-readonly", "get pods
-n default")` and never sees the NATS round-trip underneath.

**Orchestrator dispatch** (`apps/agent-orchestrator`): `AgentDescriptor`
gains `toolRefs?: string[]` (populated from the Agent CR's `spec.toolRefs`,
`crd-agent-registry.ts`). `AgentOrchestratorChannel.awaitReply` gains an
`onToolCall` callback invoked for every `tool_call` up-message seen while
awaiting the run's reply (fired without blocking the read loop — an agent may
issue another tool call, or the final reply, before the first call's tool
finishes), and a new `resolveToolCall(agentRunId, callId, outcome)` method
publishes the correlated `tool_result` down-message. `graph.ts` wires
`onToolCall` at all three places it already holds a live `AgentDescriptor` and
calls `awaitReply` — `delegateToAgent`, `checkActiveAgentRun`, and the
agent-backed-Tool branch of `runTool` — using a new `dispatchResolvedTool`
helper that runs a `ToolDescriptor` (container Job or LocalTool) and reports
`{ok, result}`/`{ok:false, error}`, plus a `deps.toolCatalog` direct-lookup
port (`{ getById(id) }`, backed by the same `toolsById` map ADR 0020 already
built in `index.ts`) to resolve `tool` by id without going through the
RBAC-filtered `VectorStore`.

**Wired at two of the three `awaitReply` call sites, not all three.**
`graph.ts` calls `deps.agentChannel.awaitReply` in three places:
`checkActiveAgentRun` and `delegateToAgent` (both hold a live
`AgentDescriptor` directly — `toolRefs` is right there), and the
agent-backed-`Tool` branch of `runTool` (a Skill's `toolRefs`/`agentRefs`
resolved into a `ToolDescriptor`, ADR 0021 — which carries an
`agentRunTemplate` but not the wrapped Agent's own `toolRefs`). `onToolCall`
is wired at the first two only. Reaching the third would mean an extra
`agentStore.getByIds` round trip mid-dispatch, gated by the ORIGINAL caller's
roles against the wrapped Agent's `allowedRoles` — a check today's
agent-backed-tool path doesn't otherwise require (only the Tool's own
`allowedRoles` gates selection) — and would fail in confusing, RBAC-shaped
ways rather than the plain "not configured" errors this ADR otherwise favors.
Left unwired for v1: a sub-agent reached via a Skill's agent-backed tool that
calls `session.callTool()` gets no reply (its `tool_call` is silently
unhandled by `awaitReply`'s `default` branch) until the whole turn times out.
Revisit alongside the "v1 scope cut" below if a real use case needs it.

**Why a separate, non-RBAC lookup instead of reusing `vectorStore.getByIds`.**
Every existing tool lookup in `graph.ts` is gated by the WALK-IN CALLER's
roles (`state.identity.roles`) because the orchestrator is deciding, on that
caller's behalf, which tools THEY may reach. A running sub-agent's `tool_call`
is a different question entirely: which tools did the OPERATOR declare this
AGENT may call, independent of whoever's chat turn originally launched it
(same as `AgentReconciler`'s validation, which also isn't caller-scoped).
Routing it through `vectorStore.getByIds` would need a synthetic caller-roles
filter that either coincidentally works (fragile) or requires threading the
launching caller's roles across the entire life of a possibly long-running
AgentRun for no real benefit. A plain id-keyed map, already built at startup
and kept live by the same k8s watch as `toolsById`, is both simpler and a more
accurate model of what's actually being authorized.

**v1 scope cut**: `dispatchResolvedTool` only reaches container Tools
(`jobTemplate`) and LocalTools (`localExec`) — an agent-backed Tool
(`Tool.spec.agentRef`) requested via a sub-agent's own `toolRefs` returns a
clean `{ok:false}` error rather than recursively launching another AgentRun.
Chaining sub-agent -> tool-call -> agent-backed-tool -> another sub-agent
raises depth/cost/cycle questions (unbounded recursion, budget accounting)
this issue didn't ask to solve; revisit if a real use case needs it.
Continuation tokens (ADR 0017) and `actionHistory` bookkeeping — both
specific to the orchestrator's own planner loop — don't apply to a raw
sub-agent tool call either; each `callTool()` is a one-shot request/response.

## Consequences

- A sub-agent built on `packages/agent-runtime` can call any Tool its launching
  Agent CR declares in `toolRefs`, through one SDK method, with the dispatch
  mechanics (ToolRun launch vs. LocalTool exec, NATS vs. HTTP callback mode)
  entirely hidden.
- `AgentSpec.ToolRefs` is additive — omitted (as on every existing Agent CR)
  means the sub-agent has no callable tools, unchanged from today.
- `dispatchResolvedTool` duplicates (rather than replaces) the container/
  LocalTool dispatch branch already inline in `runTool` — deliberately, to
  avoid refactoring a node with substantial existing test coverage
  (continuation tokens, `actionHistory`, self-improvement suggestion) that a
  raw sub-agent tool call has no use for. Converging them is a reasonable
  follow-up once both call sites are stable.
- Agent-backed tools are not yet reachable from a sub-agent's own `toolRefs`
  (see scope cut above) — only from the orchestrator's own Skill-mediated
  path, same as before this ADR.
