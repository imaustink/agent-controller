# 0036. The agent loop can run as Temporal workflows, selected by `AGENT_ENGINE`

Date: 2026-08-02

## Status

Proposed

Amends [0002](0002-langgraph-agent-loop.md) (the LangGraph loop), and retires or
narrows the coordination machinery in
[0006](0006-async-http-invoke-interface.md) (in-memory invocation records),
[0012](0012-session-scoped-skill-lifecycle.md) /
[0017](0017-continuation-tokens-via-session-store.md) (session store) and
[0033](0033-resumable-agent-turns.md) (the reply-ack hold) **for turns that run
on this engine**. Nothing is retracted: with `AGENT_ENGINE=langgraph`, the
default, every one of them remains exactly as it is.

## Context

ADR 0002 chose LangGraph because the flow is "stateful, branching, resumable,
waiting on asynchronous Job completion mid-turn". That description is accurate,
and it is also a description of a durable execution engine's product.

Look at what the ADRs since have had to build to keep that flow correct while
the loop itself is not durable:

- **Tool results resolve through in-memory pending-promise maps.** A restart
  between launching a Job and receiving its callback loses the turn.
- **ADR 0006's invocation records live in a process `Map`**, and that ADR
  documents the restart/scale-out loss itself.
- **ADR 0012/0017's session store** (active skill, continuation tokens, pending
  identity links) is explicitly best-effort.
- **ADR 0034** found every linked credential in the cluster gone, because the
  store behind two "durable" interfaces was a Redis with `--save ""` on an
  `emptyDir`. The interface promised what the implementation could not deliver.
- **ADR 0033** is the clearest case. An agent turn's work lives in a Job pod;
  the turn's *wait* lives in an orchestrator pod. `release.yml` deploys on every
  push, and the incident that prompted that ADR recorded **eleven rollouts in
  fourteen hours**. Core NATS has no durability, so a `reply` published while no
  orchestrator is subscribed is discarded outright. The fix — make the agent
  hold its concluding message and re-offer it every 10s until acked, using the
  Job pod as the buffer — is careful, correct, and entirely about compensating
  for a wait that cannot survive a deploy. Its own closing line notes it is
  retired by durability arriving.

Each of those is a good local decision. Together they are four state stores and
a hold protocol standing in for one property.

## Decision

Add a second implementation of the agent loop as Temporal workflows, and select
between them with `AGENT_ENGINE=langgraph|temporal`. The default is
`langgraph`.

### 1. The loop moves; the front door does not

`agent-orchestrator` keeps `/v1/chat/completions`, `/invoke`, identity and RBAC
resolution, the authorization pre-flight (ADR 0030/0031), the credential store
(0034), both launchers, and session pages. `AGENT_ENGINE` chooses only whether a
turn runs `buildAgentGraph()` or is forwarded to `engines/temporal`.

This is where the reviewable-change argument lives. The claim is about the loop.
Every layer above it is where the last six weeks of work landed, and bundling
its replacement into the same change would mean reviewing two unrelated risks at
once.

`AgentGraphLike` (invoke + stream) was already the Server's dependency, so this
is a second implementation of an existing interface, not a refactor. The full
existing suite passes unchanged.

### 2. Over HTTP, not with an embedded Temporal client

The engine's Go gateway already implements the accept/poll contract, so
`TemporalEngine` is an HTTP client for it. The alternative — embedding
`@temporalio/client` — was rejected because it adds a substantial dependency for
one call, gives one protocol two definitions, and puts Temporal credentials in
the pod that already holds the Kubernetes identity. `docs/orchestrator.md`
reasons explicitly about that pod's blast radius; keeping it unchanged is worth
an extra in-cluster hop.

Two existing contracts are reused rather than bypassed on that hop. A sender
login travels as a signed `x-gateway-user-assertion` (ADR 0030 §6), because it
selects the caller's principal and therefore which stored credentials a run
receives — an internal hop is exactly as unsuited to trusting it unsigned as an
external one. And a route target is *named* rather than re-derived, since the
orchestrator owns the `IntegrationRoute` registry; re-matching in the engine
would put routing policy in two places, which is what ADR 0024 rejected when it
declined to let integration-gateway launch AgentRuns directly.

### 3. Pod agents keep their NATS channel

The engine's own ADR 0001 dropped NATS. That is right for agents written for it
and wrong for the ones already running: ADR 0026's live tunnel, ADR 0028's
sub-agent tool calls and ADR 0033's hold all live on that channel, and
`claude-code-swe-agent` is the production triage agent.

So a bridged execution style drives an **unmodified** `AgentRun` over the
existing protocol — same image, same CR, same subjects — with a workflow holding
the durable half of the conversation. Nothing in production is rewritten as a
precondition for merging.

That bridge is also where the thesis is easiest to check. ADR 0033's hold exists
because the process holding the wait can vanish; a workflow cannot, so the
bridge acks on receipt. The hold is not deleted, because the *bridge* is not the
workflow: the ack is sent only after Temporal accepts the signal, so a bridge
crash leaves the agent still holding, which is the recoverable state. Re-offers
reuse their `seq` — as ADR 0033 deliberately guarantees — so a duplicate is
re-acked rather than re-delivered.

### 4. Credentials must not enter workflow state

Upstream keeps a resolved credential in a node-local variable so it never
reaches graph state. The equivalent alone would be **weaker** here, not equal:
anything a workflow holds is written to Temporal event history, durably and in
the clear, for the workflow's retention.

So the engine's pre-flight writes resolved values into a Kubernetes Secret and
returns only that Secret's name plus the env var names. One function handles a
credential value; the launcher references it and the kubelet is the only reader.
A test serializes a verdict exactly as Temporal would and asserts no token
appears in it.

### 5. Enabling it is two steps

`temporal-engine.enabled=true` deploys the worker and gateway.
`agent-orchestrator.config.agentEngine=temporal` routes turns to them. Step one
alone changes no behaviour, so the engine can be deployed, observed and rolled
back before a single turn depends on it.

Temporal itself is already running on the target platform, so the subchart takes
an address and bundles no server. A deployment without Temporal leaves the
engine disabled, which is the default.

## Consequences

**What gets simpler, for turns on this engine.** The four state stores collapse
into workflow state. `/invoke`'s record is a workflow update rather than a
process `Map`, so any replica can answer a poll and a gateway dying mid-turn
costs the caller nothing — ADR 0006's documented loss and ADR 0033's "the
interrupted turn itself is still lost" both stop being true. HITL waits and
device-flow waits become durable waits with no pod idling on a human. Recursion
caps, cancellation propagation and per-run visibility come from the parent/child
model rather than being hand-rolled.

**What gets more complex.** Two agent loops exist until the flag has been
flipped long enough to trust the second one, and the LangGraph graph is only
deletable after that. Workflow determinism rules apply inside the engine (UUIDs
and clocks via side effects; no catalog watches in workflow code). Temporal
payload limits (~2MB) mean large tool results will eventually need the artifact
object-store path the messaging roadmap already anticipates.

**Differences a reviewer should accept or reject individually**, each documented
at its call site rather than smoothed over:

- A streaming caller on this engine gets its answer but no per-node narration —
  those lines describe LangGraph node transitions, which do not exist there.
- `persistSession` writes nothing for this engine, because the workflow holds
  that state. It merges rather than replaces, so an all-undefined outcome is a
  no-op. This is also why the flag is process-wide: the two engines keep
  conversation state in different places, so alternating mid-conversation would
  lose whichever one it left.
- Route tie-breaking is deterministic (lexicographic by route id) rather than
  insertion-ordered, because the engine's table is a Go map and insertion order
  would differ between processes holding identical routes.
- The out-of-scope tool guard compares against a skill's declared *and* resolved
  tools, so neither an RBAC-hidden ref nor an unpopulated descriptor can make
  one of a skill's own tools look foreign.
- The identity gate (ADR 0032 §5) is applied to sub-agent tool calls, which the
  current dispatch path skips — a Tool meant to act as a specific human would
  otherwise run with whatever static token its template carries. This looks like
  a small upstream bug and is worth fixing on the LangGraph path too.
- The identity-link wait is a short bounded hop under a durable timer rather
  than one long-held request, so the fragility ADR 0033 describes does not apply
  to it.

**The acceptance test is the existing e2e suite**, run whole under
`AGENT_ENGINE=temporal`. Everything must pass unchanged, with one deliberate
exception: the `resilience` and `rollout-recovery` specs encode losses that stop
occurring, so they need re-baselining rather than passing as written. That
re-baselining is the evidence, not a workaround.
