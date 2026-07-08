# 0002: Agent reasoning loop built on LangGraph.js

**Status:** accepted

## Context

`recipe-scraper` uses the raw OpenAI SDK directly (function calling /
Structured Outputs) with no extra framework, because its LLM usage is a single
bounded call (format extracted content into a schema) — see
[tools/recipe-scraper/src/llm](../../tools/recipe-scraper/src/llm). The
orchestrator's job is different in kind: a multi-step loop that resolves
identity, retrieves candidate tools via RAG, decides which to invoke
(possibly repeatedly), launches k8s Jobs, waits on results, and may recurse
into sub-agents — with state that needs to persist and branch across those
steps.

Options considered:

- **Raw OpenAI SDK function calling**, hand-rolling the loop (as
  `recipe-scraper` does) — rejected for the orchestrator specifically: the
  control flow (retrieve → plan → launch → await → replan/respond, plus
  sub-agent recursion) is exactly the kind of stateful, branching, resumable
  graph that a hand-rolled `while` loop reimplements poorly over time.
- **LangGraph.js** — chosen: gives explicit nodes/edges for the steps above,
  first-class state, and a model for resumable/looping execution that fits a
  process that's waiting on asynchronous k8s Job completion mid-"turn".

## Decision

The orchestrator's core reasoning loop is a LangGraph.js graph. `recipe-scraper`
and other simple, single-call tools are unaffected and keep using the raw SDK
pattern — this decision is scoped to the orchestrator only, not a repo-wide
framework mandate.

## Consequences

- New dependency (`@langchain/langgraph` and friends) isolated to the
  orchestrator's own `apps/agent-orchestrator/package.json` — not added to
  `packages/messaging` or `recipe-scraper`.
- Graph nodes map directly to the flow in
  [orchestrator.md](../orchestrator.md#1-agent-core--langgraphjs): resolve
  identity → retrieve tools (RAG) → plan/select → launch Job → await result →
  loop or respond.
- Sub-agent delegation is just another edge (launch a Job whose image is the
  orchestrator itself), not a separate implementation.
