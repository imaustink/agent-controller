# 0036. Bare Tool candidates compete directly in `selectDelegate`, not only as a last-resort fallback

Status: accepted

## Context

`selectDelegate` (`agent/graph.ts`) picked between `skillCandidates` and
`agentCandidates` via `DelegateSelector.select` — a single combined LLM
judgment. A bare `Tool` with no `Skill` wrapping it was never a candidate in
that judgment at all. It was only reachable through `noMatchFallback`'s
`selectFallbackTool`, itself only invoked when `selectDelegate` found **both**
`skillCandidates` and `agentCandidates` empty (or the combined selector picked
neither).

This meant an `Agent` whose description loosely overlapped a request via
embedding similarity alone would pre-empt a `Tool` that was actually the
better fit for that request — not because the Agent won a head-to-head
comparison, but because a Tool never got the chance to be compared at all
once any Agent candidate existed. In a deployment with few Agents and a broad
one (a general-purpose coding agent, "runs bash, file-read/write, grep,
glob..."), this starved out every unwrapped Tool for any request that
vaguely resembled "run a command" or "do a task," regardless of a
purpose-built Tool sitting right there in the catalog.

Concretely: a homelab `ssh` Tool (a single container Tool, no `Skill`) never
got considered for "SSH into `<host>` and run `<command>`" because
`claude-code-swe-agent` — the only `Agent` in the catalog — matched first via
loose overlap, and then hung on its own identity-link gate (a known,
unrelated class of bug: `fix/claude-auth-submit-hang` et al.). The `Tool`
was correctly indexed, correctly role-scoped, and would have been picked by
`ToolFitChecker` as a genuine fit — it simply never got asked.

The obvious workaround — wrap every such Tool in a `Skill` so it competes on
equal footing — treats the symptom per-Tool rather than the actual asymmetry:
any future unwrapped Tool hits the identical starvation the moment a broad
Agent (or Skill) exists in the catalog.

## Decision

Retrieve Tool candidates on every fresh-retrieval turn, not only as a
fallback, and offer them to the SAME combined choice as Skills/Agents.

**New `retrieveTools` node** (`agent/graph.ts`), inserted between
`retrieveAgents` and `selectDelegate`: runs the full-catalog embedding query
(`deps.vectorStore.query`) and filters through the existing `ToolFitChecker`
— the same two-stage relevance gate `selectFallbackTool` already used, reused
rather than re-invented. Guarded on `deps.delegateSelector` being configured:
a non-NATS deployment has no combined selector to hand tool candidates to, so
it skips the extra embedding query + fit-check LLM calls entirely and keeps
using the unchanged skill-only path (which still falls through to
`noMatchFallback`/`selectFallbackTool` exactly as before).

**`DelegateSelector.select`** (`agent/delegate-selector.ts`) gains a third
parameter, `tools: ToolSearchResult[]`, and `DelegateChoice` gains a `"tool"`
variant. `OpenAiDelegateSelector`'s prompt is extended with an explicit
three-way preference order: skill (authored guidance) > bare tool (single
well-defined action, no authored guidance needed) > agent (open-ended,
multi-step, or likely to need clarifying questions) — the same "prefer a
skill when a single tool call suffices" reasoning the prompt already had for
skill-vs-agent, now extended to include tools as their own tier rather than
lumping them under "whatever's left after skills and agents miss."

**`selectDelegate`**'s NATS branch: the empty-check now also considers
`toolCandidates`/`callerTools` before falling to `noMatchFallback`. When the
combined choice is `"tool"`, a new shared helper `planFallbackToolCall`
(extracted from `selectFallbackTool`'s own tail, now used by both) asks the
action planner to construct the actual `toolArgs` for that one chosen tool
plus any caller-supplied tools — declining is still legitimate here
(`FALLBACK_TOOL_MARKDOWN`'s "decline rather than force a guess on an unclear
or multi-step request" applies regardless of how the tool got offered). A
decline, or the combined selector returning no choice at all despite
candidates existing, falls through to `noMatchFallback` as a safety net —
accepting a redundant second embedding query on that (expected to be rare)
path rather than adding complexity to avoid it.

`selectFallbackTool` and `hasOutOfScopeToolMatch` are unchanged and still
used: the former as the safety net just described (and as the sole tool path
in non-NATS deployments), the latter for active-skill-continuity's
out-of-scope-tool detection, an orthogonal concern.

## Consequences

- A bare Tool can now win the combined choice on its own merits against a
  Skill or Agent, not only when nothing else was ever offered. Fixes the
  starvation case above without requiring every future Tool to be wrapped in
  a Skill just to be reachable at all.
- Cost: every fresh-retrieval turn in a NATS (agent-delegation-configured)
  deployment now pays for one embedding query + up to `fallbackToolTopK`
  `ToolFitChecker` LLM calls, even turns that end up matching a Skill or
  Agent easily — previously this only happened on a Skill+Agent miss. A
  non-NATS deployment is unaffected (the `retrieveTools` guard above).
- `DelegateSelector` is a breaking interface change (third parameter); the
  only implementation in this codebase (`OpenAiDelegateSelector`) and its
  tests were updated in the same change. An external implementation would
  need updating too — acceptable since this is internal orchestrator code,
  not a published package.
- A Skill still beats a fitting bare Tool when both apply (per the prompt's
  preference order) — this doesn't retire authored Skills; it only stops
  Tools from being invisible to the choice that a Skill or Agent already had.
