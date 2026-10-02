# 0045. `MCPServer`: proxied Model Context Protocol tools

Date: 2026-10-02

## Status

Proposed

## Context

People want to point the agent at a Model Context Protocol (MCP) server and have
its tools become callable. The naive way to do that is to give the agent loop an
MCP client: let it connect, list tools, and call them. We do not want to do
that, and the reasons are the whole reason this ADR exists.

An MCP server is an open-ended, stateful, externally-controlled peer. It speaks
a session protocol (initialize, capabilities, notifications), it can hand back
tools whose names and schemas we did not write, and — over `streamable-http` or
`sse` — it often wants to authenticate *as the end user*, not as the service.
Wiring that directly into the agent loop would:

- put an MCP client, its session lifecycle and its auth handshake inside the one
  process we most want to keep boring and deterministic;
- bypass the catalog entirely, so MCP tools would skip the RBAC-scoped,
  fail-closed retrieval filter every other tool goes through (ADR 0004), the
  `hidden` flag (0008), per-agent `toolRefs` (0028) and skill-derived access
  (0011); and
- let a server widen its own surface — advertise a new tool tomorrow and have
  the agent discover it — with no operator in the loop.

So the catalog is the thing we want MCP tools to *be*, and the agent loop is the
thing we want them to stay away from. The repo already has every piece needed to
do this:

- **A dispatch-kind union.** A `ToolDescriptor` carries exactly one of
  `jobTemplate` (container Job), `localExec` (in-pod sidecar), `agentRunTemplate`
  (agent-backed) or `callerTool` (caller-executed). Dispatch branches on which
  is set. A new kind is the established way to add an execution path.
- **A proxy precedent.** ADR 0014's `LocalTool` already runs code the
  orchestrator refuses to touch: it resolves secrets, POSTs one request to a
  sidecar over a pod-local unix socket, and maps the reply onto the ordinary
  tool-event envelope. The engine never imports the runtime it is invoking. MCP
  is the same shape with a different transport.
- **A scoped-external-resource precedent.** ADR 0038/0043's `Connection` is an
  operator-authored, credential-bearing, namespace-pinned CR whose real work
  happens in an out-of-cluster broker, not its reconciler. That is almost
  exactly the control-plane shape an MCP server needs — it is just
  *content*-ingestion shaped rather than *tool-call* shaped, so MCP cannot live
  on `Connection` itself.
- **Per-user delegation.** ADR 0032/0040/0041 already resolve a per-user
  delegated token at call time and inject it, keyed off `identityProviders`.
  That is the answer to "the MCP server wants to act as the user."

Nothing about MCP is new to this system *except* the wire protocol. The design
below is mostly a matter of pointing existing machinery at it and refusing to
let the protocol leak inward.

## Decision

Introduce two CRDs and one broker. A remote MCP tool becomes an ordinary catalog
record with a new dispatch kind; the agent loop treats it like any other tool;
only the broker ever speaks MCP.

```
MCPServer   transport + endpoint + credentials       operator-authored
            + identityProviders + exposure map        one per server

MCPTool     a derived catalog record, mcpExec kind    broker-written, never
            = { serverRef, remoteToolName, schema }    hand-edited; owned by its
            + allowedRoles                             MCPServer

mcp-broker  holds MCP sessions; lists and proxies     the only MCP speaker
```

### 1. Two CRDs, split by who authors them

`MCPServer` is authored by an operator and answers *what server, reached how,
with whose credentials, exposing which tools to which roles*. `MCPTool` is
**written by the broker** and is a derived object — the materialized form of one
exposed remote tool, carrying an `mcpExec` dispatch spec and the `allowedRoles`
the operator assigned it. It has an `ownerReference` to its `MCPServer`, so
deleting the server cascades its tools.

The split is deliberate and mirrors `Connection`/`Corpus` discipline: the thing
the server advertises is derived state, not desired state, and nobody should
hand-edit it. A distinct kind makes "do not touch this, the broker owns it"
structural rather than a convention. It also keeps the trust boundary legible —
`MCPServer` is the privileged, reviewed object; `MCPTool` is machine output
gated by it.

### 2. `mcpExec` is the fifth dispatch kind, in both engines

Add `mcpExec = { serverRef, remoteToolName, inputSchema }` to the descriptor
union — the Go `ToolDescriptor` (`engines/temporal/internal/catalog`) and the
TypeScript one (`apps/agent-orchestrator/src/tool-descriptor.ts`) — and a branch
in each dispatcher (`agentloop.go`'s `runToolWithContinuation`, `dispatch-tool.ts`'s
`dispatchResolvedTool`) that relays the call to the broker over the same envelope
`localExec` uses. Both engines land this together rather than one leading: the
descriptor field and the broker ABI are a shared contract, and the Temporal port
already carries catch-up debt against TypeScript (`callerTool`, `corpusGetExec`)
that we are not going to widen.

The embedded RAG text is the remote tool's `description` plus its input/output
schema, exactly as for every other tool — so an MCP tool competes in retrieval
and delegate selection (0037) with no special case. From the agent loop's side
there is no such thing as an MCP tool; there is a tool whose dispatch happens to
be `mcpExec`.

### 3. The broker is the only MCP speaker

A new `mcp-broker` deployment — sibling to `connection-broker`, same posture as
the localtool executor — owns every MCP session and does two jobs:

- **Discovery.** It connects to each `MCPServer`, runs `tools/list`, and writes
  the full inventory to `MCPServer.status.discoveredTools` (name, description,
  schema). This grants nothing; it only *surfaces* what the server offers so an
  operator can decide what to expose (§4).
- **Invocation.** At call time it receives the internal tool-call envelope,
  resolves the caller's credential (§5), performs one `tools/call`, and maps the
  result back onto the ordinary tool-event envelope.

The engine imports no MCP client, holds no MCP session, and sees no MCP framing —
the same containment ADR 0014 gives `LocalTool`. Creating an `MCPServer` is a
**privileged operation**, on par with creating a `LocalTool`: it introduces an
externally-controlled call path reachable by agents, and must be gated by k8s
RBAC on the CR.

### 4. Granular exposure is default-deny, operator-driven

`MCPServer.spec` carries an **exposure map**: for each remote tool the operator
chooses to expose, an entry `{ remoteToolName, expose, allowedRoles, toolId?,
hidden?, tier? }`. The broker materializes an `MCPTool` **only** for entries with
`expose: true`, stamping the operator-assigned `allowedRoles`. A server with an
empty exposure map contributes nothing, however many tools it advertises.

This is the same reasoning as `Connection`'s scope cap (0043 §3): the surface a
remote system can present must be bounded next to the credential, not taken on
the remote system's word. A server that adds a tool tomorrow appears in
`status.discoveredTools` and nowhere else until an operator maps it. The remote
tool's own advertised metadata never grants it visibility or a role — those are
the operator's to assign, which is what keeps the materialized record
trustworthy once it reaches the fail-closed retrieval filter.

Because materialized `MCPTool`s are ordinary catalog records, all three existing
RBAC layers apply unchanged and for free: the `allowedRoles` Qdrant filter
(0004, fail-closed), `hidden` for reference-but-not-retrievable (0008), and the
per-agent `toolRefs` allowlist (0028). MCP adds no new authorization machinery;
it feeds the existing machinery.

### 5. Invocation runs as the user, per call, via `identityProviders`

The primary auth target is **stateless `streamable-http` servers with a per-call
bearer token**. `MCPServer.spec.identityProviders` names the identity providers a
caller must have linked; at dispatch the broker resolves that caller's delegated
token (the 0032/0040/0041 path) and presents it on a fresh `tools/call`. The
broker holds no per-user session: discovery identity (service credential, for
`tools/list`) and invocation identity (per-user, for `tools/call`) are separate
concerns, and only the former is shared.

This is a load-bearing choice, not an incidental one. An MCP session is stateful
and auth-context-bound, but the catalog is shared across users. A broker that
held one session and fanned every caller through it would reproduce the
shared-subject class of bug one layer down — the thing we have paid for before.
Keeping invocation sessionless and per-call is what prevents that by
construction.

Token expiry is made explicit rather than left to fall through: if a caller's
delegated token cannot be resolved or has expired, the call **fails closed** with
an authorization error. It does **not** silently fall back to the discovery
service credential — a per-user call quietly becoming a shared-identity call is
precisely the failure mode to forbid.

Servers that need a stateful session or cannot take a per-call token
(stdio-only, or SSE with a session-bound handshake) are out of scope for this
ADR. The broker ABI is designed so a per-`(server, caller)` session pool can be
added later as a second auth mode, but the default stays sessionless.

### 6. The live server is truth for existence; the operator is truth for permission

When discovery finds that an exposed remote tool has been **renamed or removed**,
the broker **deletes the derived `MCPTool`** (equivalently, drives it `NotReady`
and drops it from the index) rather than retaining it stale. A tool that the
server no longer offers is not callable, and leaving a tombstone in the catalog
that fails only when invoked is worse than removing it — the retrieval layer
should not surface a tool that cannot run.

The division of authority is the point: the **live server decides what exists**;
the **operator decides what is permitted**. A remote tool reappearing does not
re-expose itself — it re-enters `status.discoveredTools` and waits for the
exposure map, exactly as a never-before-seen tool would. So existence tracks the
server automatically, while permission never moves without an operator, and the
two can never be confused for one another.

## Consequences

**MCP tools are catalog citizens, not a side channel.** They are retrieved,
RBAC-filtered, hidden, referenced by skills and gated by `toolRefs` with no
special case, because they are the same kind of record every other tool is. The
agent loop has no concept of MCP.

**The protocol is quarantined in one deployment.** Only `mcp-broker` links an MCP
client. A malformed or hostile server can waste the broker's time or fail a call;
it cannot reach the agent loop's process, secrets or k8s identity.

**Exposure is bounded and auditable.** Nothing is callable that an operator did
not put an `expose: true` entry behind, and what a server advertises is visible
on `status.discoveredTools` without being live. A server cannot widen its own
surface.

**Per-user auth reuses the delegation path and fails closed.** No new credential
model; `identityProviders` does the work, and an expired token is an error, never
a silent downgrade to shared creds.

**Two engines move together.** The descriptor field, the broker ABI and both
dispatch branches are one contract landed in lockstep, which is more up-front
work than leading with one engine but avoids parity debt on a brand-new kind.

**A new broker to run.** One more deployment, one more namespaced Role (the
broker reads `MCPServer` + its Secrets and writes `MCPTool`, in the KB namespace
only — never a ClusterRole). Defaulted off in the chart, like LocalTools.

**Stateful/stdio servers are deferred.** The common case — an HTTP MCP server
with OAuth — is covered; stdio and session-bound SSE servers wait for a second
auth mode. This is a real limitation, called out so it is a decision and not a
surprise.

## Alternatives considered

**Give the agent loop an MCP client.** The straightforward thing, rejected in
Context: it puts a stateful external protocol and its auth handshake inside the
deterministic core, and skips every catalog-level control. The entire value of
this design is *not* doing this.

**Put MCP on `Connection` as another provider.** Tempting because `Connection` is
the existing provider-discriminated, credential-bearing, namespace-pinned CR. But
`Connection` is content-ingestion shaped — it feeds `Corpus`/`KnowledgeBase`
retrieval, not tool dispatch — and its reconciler/driver contract is about
listing and fetching documents, not calling tools. Overloading it would conflate
two subsystems that are cleanly separate today. MCP borrows `Connection`'s
*shape*, not its CRD.

**Broker upserts Qdrant directly, no derived CR.** Fewer moving parts: the broker
lists tools and writes descriptors straight to the vector store, as the LangGraph
in-process watcher does for its own CRs. Rejected because it splits indexing
authority (two writers into Qdrant with different rules) and takes the exposed
surface out of the declarative, gitops-visible, RBAC-gated CR layer — the derived
`MCPTool` is what makes exposure reviewable and what lets catalog-sync stay the
single indexer.

**Status-only: discovered tools live on `MCPServer.status`, a controller fans
them out.** A middle ground where the broker never writes a second CR. Rejected
as the worst of both: the exposed surface is neither a first-class object an
operator can `get`/RBAC individually, nor a clean single-writer path — it is a
fat status blob plus a fan-out controller doing what an owned derived CR does
more simply.

**One shared MCP session per server.** Simplest invocation path, and fine for a
genuinely shared read-only server. Rejected as the *default* because it
reintroduces shared-subject identity collapse the moment a server cares who is
calling; a shared service identity is allowed only as an explicit, documented
per-server choice, never the silent default (§5).

## Rollout

1. Land this ADR before code: the `mcpExec` contract and the exposure/auth model
   are easier to review as reasoning than as a two-engine diff.
2. Add `MCPServer` and `MCPTool` CRDs with CEL validation; add the `mcpExec`
   field to both descriptor models and both dispatchers. Regenerate RBAC and
   **hand-add the new resources** to the core-controller chart's `rbac.yaml` and
   copy the CRD YAMLs into `charts/.../crds/` in the same commit — neither is
   picked up automatically — and bump the chart version so Argo re-renders.
3. Build `mcp-broker` discovery: connect, `tools/list`, write
   `status.discoveredTools` and derived `MCPTool`s honoring the exposure map and
   the existence rule (§6). No invocation yet.
4. Teach both catalog-sync paths to index `mcpExec` records; prove the new RBAC
   assertions *can* fail before trusting them.
5. Build `mcp-broker` invocation and the dispatch branches: per-user token
   resolution, the proxied `tools/call`, fail-closed token expiry, error/timeout
   envelope parity across engines.
6. Harden: broker failure modes, a conformance test server, and docs for the
   privileged nature of `MCPServer` creation.

This ADR introduces a new capability and supersedes nothing. It reuses ADR 0014's
proxy posture, ADR 0038/0043's scoped-resource shape, ADR 0004/0008/0028's RBAC
layers and ADR 0032/0040/0041's delegation unchanged.
