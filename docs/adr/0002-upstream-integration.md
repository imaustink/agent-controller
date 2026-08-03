# ADR 0002 — Upstreaming the Temporal engine into agent-controller

- Status: accepted
- Date: 2026-08-02
- Amends [ADR 0001](0001-agents-as-temporal-workflows.md) §6

## Context

[ADR 0001](0001-agents-as-temporal-workflows.md) rebuilt agent-controller's
agent half on Temporal as a standalone system, forked from upstream at commit
`e62b227` (2026-07-21). Its thesis — that most of upstream's coordination
machinery compensates for a loop that is not durable — held up: seven
milestones landed, and the four ad-hoc state stores ADR 0001 named were
replaced by workflow state.

The maintainer has agreed to take it upstream. That changes the constraints in
two ways.

First, upstream did not stand still. In the ~six weeks after the fork it moved
237 commits and added twelve ADRs (0024–0035), including a deterministic event
router, an authorization pre-flight with principals, caller-supplied tools, a
durable credential store, and — most consequentially here — a production
Claude-based coding agent built on the very NATS channel ADR 0001 dropped.

Second, "a fork that proves a point" and "a change a maintainer can merge" are
different artifacts. The second one has to not regress anything.

The catch-up work is tracked in
[upstream-catchup-plan.md](../upstream-catchup-plan.md).

## Decision

### D1. Catch up on the loop and the contracts, not the whole system

Port upstream's agent-loop semantics and CRD schema, plus the wire contracts
needed to sit behind the real integration-gateway: the `/invoke` event
descriptor, the signed sender assertion, and the identity-link gateway client.

Do **not** reimplement services that stay upstream — the webhook adapter, the
credential store, the coding-agent images. Anything reimplemented is code that
gets deleted during the merge, and a second implementation of credential
keying is the shape of a real upstream bug (PR #144).

### D2. Pod agents keep their NATS channel; ADR 0001 §6 is amended

ADR 0001 §6 said NATS is dropped and the bidirectional agent channel becomes
workflow signals. That reasoning still holds for agents we write. It does not
hold for the ones already running.

Since the fork, upstream built the live opencode tunnel (ADR 0026), sub-agent
tool calls (ADR 0028) and the reply-ack hold (ADR 0033) on that channel, and
`claude-code-swe-agent` — which speaks it — became the **production triage
agent**. Requiring it to be rewritten as a precondition for merging would trade
the maintainer's working system for our architectural preference.

So there are three execution styles, all speaking the same parent-facing
signal protocol:

| Style | What it is |
| ----- | ---------- |
| `AgentWorkflow` | the declarative loop; a sub-agent is a child workflow |
| `PodAgentWorkflow` | checkpoint-resume step Jobs (ADR 0001 §5) |
| `BridgedAgentWorkflow` | an **unmodified** upstream `AgentRun` over NATS |

The bridge is where ADR 0001's thesis gets its sharpest demonstration rather
than its widest application. ADR 0033 exists because an agent turn's work lives
in a Job pod while the turn's *wait* lives in an orchestrator pod, and the
second lifetime is far shorter — eleven rollouts in fourteen hours, in the
incident that prompted it. Core NATS has no durability, so a `reply` published
while nothing is subscribed is discarded, and the fix was to make the agent
hold its concluding message, re-offering every 10s until acked.

Here the wait is a workflow, so the buffer has nothing to buffer against and
the bridge acks on receipt — which ADR 0033 itself names as its exit condition
("`AGENT_REPLY_ACK_TIMEOUT_MS=0` is the switch that retires it"). The hold is
not deleted, because the bridge process is *not* the workflow: the ack is sent
only after Temporal accepts the signal, so a bridge crash leaves the agent
still holding, which is the recoverable state.

### D3. Upstream shape: TypeScript front door, Go loop, feature-flagged

`agent-orchestrator` keeps `/v1/chat/completions`, `/invoke`, identity and RBAC
resolution, the credential store wiring, and both launchers.
`AGENT_ENGINE=langgraph|temporal` selects whether a turn runs
`buildAgentGraph()` or does update-with-start against the Go worker.

That HTTP and identity layer is where essentially all 237 commits of churn
happened. Replacing the *loop* is the claim ADR 0001 makes; replacing the
*front door* is unrelated risk bundled into the same review.

One consequence, decided deliberately: **the authorization pre-flight stays in
TypeScript upstream.** `internal/authz` exists and is fully tested, because a
standalone deployment needs it — but upstream the orchestrator runs the
pre-flight and passes the verdict in. Two owners of credential keying is
exactly what ADR 0030 §1 consolidated away.

### D4. Import by `git subtree`, and stay local until told otherwise

The engine lands as a new top-level directory in agent-controller with history
preserved, so ADR 0001 and the milestone commits survive as the design record
the maintainer reviews. Nothing is pushed and no PR is opened without explicit
authorization each time.

## Consequences

- **Nothing upstream regresses on merge day.** Default `AGENT_ENGINE=langgraph`
  means the switch is inert until flipped, and the existing e2e suite is the
  acceptance test rather than a new one written to fit.
- **Two agent loops exist for a while.** That is the cost of a reversible
  merge. The LangGraph graph is deletable once the flag has been flipped long
  enough to trust.
- **Temporal becomes a deployment dependency** when the engine is enabled. This
  is the strongest argument against the whole change and belongs in front of the
  maintainer as a question, not an assumption.
- **A credential must never enter workflow state.** Upstream keeps credentials
  out of graph state via node-local variables; the equivalent here is not
  enough, because anything a workflow holds is written to Temporal event
  history durably and in the clear. `internal/authz` therefore writes values
  into a Kubernetes Secret and returns only its name — a *stronger* property
  than upstream's, enforced by a test that serializes a verdict the way
  Temporal would and asserts no token appears in it.
- **Divergences from upstream are deliberate and enumerated**, not accidental:
  route tie-breaking is deterministic rather than insertion-ordered; the
  out-of-scope tool guard compares against declared *and* resolved tools; the
  identity gate applies to sub-agent tool calls, which upstream's dispatch path
  skips; and the identity-link wait is a short bounded hop under a durable
  timer rather than one long-held HTTP request. Each is documented at its call
  site so a reviewer can accept or reject it on its own.
