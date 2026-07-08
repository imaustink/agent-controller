# 0003: RAG tool index backed by Qdrant behind a swappable `VectorStore` port

**Status:** accepted

## Context

Tool selection should be retrieval-augmented: the agent embeds the request,
queries a vector index of tool/sub-agent descriptors, and only the top-k
relevant candidates enter the LLM's context — this is what keeps context small
as the tool catalog grows. We need a vector store, but don't want the agent
core coupled to one vendor's client/API long-term.

Options considered:

- **Postgres + pgvector** — good fit if the orchestrator already needs a
  relational store for other state, but no such need exists yet.
- **In-memory/local-file cosine similarity** — fastest to stand up, but doesn't
  reflect the intended dynamic, growing, RBAC-filtered catalog (see
  [ADR 0004](0004-rbac-scoped-dynamic-tool-discovery.md)) and has no story for
  multi-replica orchestrator deployments sharing one index.
- **Qdrant** — chosen: purpose-built vector DB, native payload filtering
  (needed for the RBAC-scoped query in ADR 0004), straightforward k8s
  deployment, and a maintained TS client.

Regardless of which store is picked, the agent core should not import a
vendor client directly, since this is exactly the kind of infrastructure
choice likely to change as requirements firm up.

## Decision

Introduce a small `VectorStore` port (interface) with the operations the agent
core actually needs: `upsert(records)`, `query(text, filter, k)`, and nothing
Qdrant-specific in the signature. Qdrant is the first and only concrete
adapter for now. All Qdrant-specific types/config/client usage stay inside
that adapter module; nothing else in the orchestrator imports
`@qdrant/js-client` directly.

## Consequences

- Swapping vector stores later (e.g. to pgvector) means writing one new
  adapter module against the existing port — no changes to the agent core,
  the reconciler that upserts tool descriptors, or the RAG-retrieval graph
  node.
- The port's `filter` shape needs to be expressive enough for RBAC-scoped
  queries (ADR 0004) without leaking Qdrant's specific filter DSL into
  callers — likely a small internal filter AST translated per-adapter.
- Adds an operational dependency (a Qdrant deployment) to the cluster,
  separate from the orchestrator's own deployment.
