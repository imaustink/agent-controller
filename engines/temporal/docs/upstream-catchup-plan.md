# Upstream catch-up and integration plan

> Status: proposed, 2026-08-02. Supersedes nothing; extends
> [ADR 0001](adr/0001-agents-as-temporal-workflows.md) milestone 8.

durable-agents was written against agent-controller at commit `e62b227`
(2026-07-21). Since then upstream has moved **237 commits / 357 files /
+50,580 −1,569**, adding **12 ADRs (0024–0035)**. The maintainer has agreed to
take the Temporal engine upstream, so this plan does two things in order:

- **Phase A** — bring durable-agents up to upstream's current semantics, so the
  engine is a like-for-like replacement rather than a fork of a July snapshot.
- **Phase B** — land the engine in agent-controller behind a switch.

## Decisions taken up front

| # | Decision | Rationale |
| - | -------- | --------- |
| D1 | **Catch-up scope = loop + contracts.** Port the graph semantics, the CRD schema, and the wire contracts durable-agents must honour to sit behind the real integration-gateway (`/invoke` event descriptor, signed sender assertion, identity-link gateway client). Do **not** reimplement services that stay upstream. | Anything we reimplement is code we then have to delete during Phase B. |
| D2 | **Pod agents: both paths.** A Temporal workflow wraps an `AgentRun` over the existing NATS agent-runtime channel, so `claude-code-swe-agent` and `opencode-swe-agent` run unchanged. Checkpoint-resume stays for new step-tool agents. | ADR 0001 §6 dropped NATS; upstream has since built the live opencode tunnel (0026), sub-agent `tool_call` (0028) and the reply-ack hold (0033) on it, and `claude-code-swe-agent` is now the **production triage agent**. Rewriting it cannot be a precondition for merging. |
| D3 | **Upstream shape: TS front door, Go loop, feature-flagged.** `agent-orchestrator` keeps `/v1/chat/completions`, `/invoke`, identity/RBAC, credential wiring and the launchers. `AGENT_ENGINE=langgraph\|temporal` selects whether a turn runs `buildAgentGraph()` or does update-with-start against the Go worker. | That HTTP/identity layer is where essentially all 237 commits of churn happened. Replacing the *loop* is the claim; replacing the *front door* is unrelated risk. |
| D4 | **`git subtree` into a new top-level dir**, history preserved. Local only — no push, no PR, until explicitly authorised. | ADR 0001 and the seven milestone commits are the design record the maintainer will review. |

D3 has a consequence worth stating early, because it changes Phase A: **the
authorization pre-flight stays in TypeScript upstream.** See A4 and B2.

---

## Where the delta actually lives

| Bucket | Upstream changes | Bearing here |
| ------ | ---------------- | ------------ |
| **Agent-loop semantics** | `checkIntegrationRoute` node (0024); `AuthorizationService`, batch pre-flight, principals (0030/0031); caller-supplied tools + a second terminal state (0035); agent `toolRefs` (0028); container-tool identity gate (0032); out-of-scope-tool guard; seeded-result finish guard | **Port.** This is the loop we reimplemented. |
| **CRD schema** | `Tool.identityProviders`, `Tool.initContainers`, `ToolRunSpec.secretEnv`, `Skill.allowCallerTools`, `Agent.toolRefs`, new `IntegrationRoute` | **Adopt** in `internal/catalog` + `internal/toolrun`. |
| **Made moot by Temporal** | ADR 0033 resumable turns / `reply_ack` hold; ADR 0006's in-memory invocation map; `shutdownDrainMs`; ADR 0034's Redis-durability incident | **Port the lesson, not the code.** These are the failures ADR 0001 predicted; they become the evidence for the upstream PR. |
| **Separate processes** | integration-gateway webhooks, `claude-code-swe-agent`, `tools/github`, `signoz-query`, `helm-values-form`, the e2e harness, CI | **Stay upstream.** We need their contracts, not their code. |

One upstream gap named in `docs/pod-agents.md` has **closed**:
`ToolRunSpec.secretEnv` landed with ADR 0032. Per-user credentials can now ride
a step Job, so the checkpoint-resume path is no longer credential-blocked.

Two parity gaps **predate** the fork and are now load-bearing, so they are in
scope even though they are not part of the delta: durable-agents has no
`selectFallbackTool`/`noMatchFallback` path (a no-skill turn goes straight to
`bareAnswer`), and no `toolFitChecker`. A7 depends on both.

---

## Phase A — catch durable-agents up

Repo is green today (`go build ./...`, `go test ./...`). Each workstream lands
green. Suggested order: **A1 → {A2, A3, A7} → A4 → {A5, A6} → A9 → A8**.

### A1. CRD schema catch-up · `internal/catalog`, `internal/toolrun`

- `ToolDescriptor` += `IdentityProviders []string` (ADR 0032 §2/§4).
- `AgentDescriptor` += `ToolRefs []string` (ADR 0028).
- `SkillDescriptor` += `AllowCallerTools *bool` — pointer, because nil means
  *allowed* and Go's zero value would silently mean "refuse" (ADR 0035 §4).
- New `IntegrationRouteDescriptor` + GVR: `match{source,event,action,labelName}`,
  exactly one of `skillRef|agentRef|toolRef`, `promptTemplate`.
- `internal/toolrun/k8s.go`: set `spec.secretEnv` on the created `ToolRun`
  (ADR 0032 §1) — mirrors `AgentRunSpec.SecretEnv`, merged over the Tool's
  static `secretEnv` by the reconciler.
- `Tool.spec.initContainers` needs no work here (the core-controller consumes
  it at Job-build time); note it and move on.
- Re-verify `derive.go`'s skill-access intersection against upstream ADR 0011 —
  expected unchanged.

### A2. Integration routing · ADR 0024

Upstream matches the route in `handleInvoke` and re-resolves it **inside** the
graph under the caller's *current* roles. Keep that split:

- Gateway matches the route (a cheap exact-equality table; most specific wins:
  `action`+`labelName` > `action` > `labelName` > neither), renders
  `promptTemplate` with dependency-free `{{field}}` substitution, and passes
  `ForcedSkillID`/`ForcedAgentID` on `TurnInput`.
- Workflow gains a route step, placed after the active-episode check and
  before the active-skill/pending-link chain, re-resolving the named target
  under RBAC. A miss is never an error — fall through.
- Route table is fed by an informer in whichever process terminates inbound
  events. Routes are *matched*, not embedded, so they do **not** go into
  Qdrant.

> **Split as built:** A2 landed the routing engine (registry, matcher,
> renderer, informer, workflow bypass, `ResolveAgent`). Starting the watch and
> reading the registry belongs to the `/invoke` handler, so it ships with A3 —
> until then nothing populates `ForcedSkillID`/`ForcedAgentID` in production.

### A3. `/invoke` + event descriptor + sender assertion · contracts

- `internal/rbac/sender_assertion.go`: Go port of `mintSenderAssertion` /
  `verifySenderAssertion` — HMAC-SHA256 over base64url `payload.signature`,
  claims `{login, exp}`, 300s TTL, constant-time compare, fail closed and
  silent. **Must be byte-compatible with the TS**; pin it with a test vector
  generated from `apps/agent-orchestrator/src/rbac/sender-assertion.ts`.
- Same both-ends startup warning when the secret is unset and the unsigned
  `event.senderLogin` body field is still trusted.
- `POST /invoke` accepting `{request, sessionId, event{source,event,action,
  labelName,senderLogin,…}}`, plus the async accept/poll pair.

  **This is the headline win.** ADR 0006's invocation record is an in-process
  `Map`; ADR 0033 closes with "the interrupted turn itself is still lost…
  making the turn itself survive means durable invocation records, which this
  does not attempt." Here the invocation record *is* the workflow. Build
  `/invoke` so the poll route reads the update handle rather than any local
  state, and that paragraph stops being true.

### A4. Identity + authorization · ADR 0029/0030/0031

- `internal/identitylink`: HTTP client for the gateway's real API —
  `POST /identity-link/:provider/start`, `GET /identity-link/:provider/identity`,
  `POST /identity-link/:provider/poll`, and claude-auth's
  `/claude-auth/api/{start,token,wait,invalidate,rekey,writeback-token}`.
  Today's `IDENTITY_LINKS` env store demotes to a fake.
- **Container-tool identity gate** (ADR 0032 §5, moved here from A7):
  `runTool`'s job-template branch gates on `tool.identityProviders` via the
  same helper as the agent-backed branch, and injects the token through
  `ToolRunSpec.secretEnv` (A1). Same v1 scope cut — this path never *starts* a
  link flow, because a paused tool call has no resume slot.
- `internal/authz`: port `AuthorizationService` as a **total** discriminated
  union — `Authorized{SecretName, ActorLogin, Principal, OwnedSecretNames}` |
  `LinkRequired{Message, Pending}` | `Misconfigured{Error}`. Batch pre-flight
  with no short-circuit (§4); principal step first (0031 §2); a pending
  principal link stops the turn (0031 §3); `CROSS_ENTRY_POINT_PROVIDERS =
  {claude, claude-remote}`; lazy `rekey`; `perUser` gate; every failure
  degrades rather than blocks (0031 §4).
- `rbac.Identity` += `Principal`, `PerUser`.
- HITL becomes `await signal` — wire link completion to signal the workflow
  instead of the gateway's watch-plus-poll.

**Temporal-specific hazard, and the main reason A4 is shaped this way.** ADR
0030 §3 keeps credential values out of model context by making them node-local
variables. In Temporal, an activity result that lands in workflow state is
written to **event history** — durably, in the clear, forever. That is strictly
worse than the TS property, not equal to it. So the authorize activity returns
the **name of the per-run Secret** and never a value; the launcher redeems it.
Add the Go analogue of §3's test: assert no credential material appears in any
workflow input, result, or activity payload on a turn that resolves every
provider.

**Build this behind an interface with two implementations** — `GatewayAuthorizer`
(standalone/dev) and `PreAuthorized` (trusts a verdict passed in on
`TurnInput`). Per D3, upstream will use the second: authorization stays in
TypeScript, keeping ADR 0030's "one authorization owner" property intact rather
than creating the second copy that ADR named as the shape of the #144 bug.

### A5. Caller-supplied tools · ADR 0035

- `internal/callertools`: parse `tools` / `tool_choice`; hard caps on count and
  on description/schema size, rejected with an OpenAI-shaped `400`; sha256
  content-hash point ids; `caller:<name>` namespacing so a caller tool can
  never shadow a `Tool` CR.
- New Qdrant collection `caller_tools` (same embedder/vector size), `lastSeenAt`
  + `prune()`. **Skip the store entirely when the caller sent ≤ K** (default 5).
  Search is restricted to ids taken from *this request's* body, which is what
  makes cross-caller leakage structurally impossible and why this collection
  alone carries no RBAC filter.
- Parse `assistant.tool_calls` + matching `role:"tool"` messages out of the
  incoming `messages` array into seeded `[]ActionRecord`. This is the resume
  path, and seeding bounds the resumed loop for free via `maxToolSteps`.
- **Second terminal shape**: `TurnResult` += `PendingToolCalls`. Render it in
  the blocking facade, the streaming facade, and `/invoke`'s polled record.
- Untrusted-block rendering in the planner prompt (one trust level below a Tool
  CR description, two below Skill markdown).
- `isInternalUiTaskRequest` short-circuit — Open WebUI's title/tag/query
  completions must return prose and can never emit `tool_calls`. In our shape
  that means short-circuiting **before** update-with-start, so the housekeeping
  request never starts or touches a conversation workflow.
- `Skill.allowCallerTools` gate.
- Port the seeded-result finish guard (`139039f`): the verbatim-repeat branch in
  `planAction` must carry `lastHistoryResult(state)` like its siblings.

### A6. Sub-agent tool calls · ADR 0028

Cheaper here than upstream, and worth saying so in the PR. Upstream needs a
`tool_call`/`tool_result` NATS pair, a `callId`-keyed pending map, and an SDK
method. A child workflow just calls the existing `runTool` helper directly.

- Gate on `agent.ToolRefs`, resolved by a **non-RBAC id lookup**. ADR 0028's
  reasoning carries over exactly: this asks which tools the *operator* declared
  this agent may call, not which tools the walk-in caller may reach.
- Same v1 scope cut: agent-backed tools are not reachable from a sub-agent's own
  `toolRefs`.
- The one place the NATS pair is still needed is A9 (a pod agent calling a tool
  from inside its own image).

### A7. Loop-semantics fixes

- **Fallback path (pre-existing gap).** Port `selectFallbackTool` +
  `noMatchFallback` + `bestEffortResponder` + `appendSelfImprovementSuggestion`.
  Today a no-skill turn drops straight to `bareAnswer`, so the full-catalog tool
  search never happens.
- **`toolFitChecker` activity** (pre-existing gap) — needed by both the fallback
  path and the next item.
- **`hasOutOfScopeToolMatch`** (`8e05c6b`): the active-skill fit check only
  judges topic continuity, so "use your kubectl access to debug this" mid-task
  inside `skill-web-search` passes the fit check and gets absorbed. Query the
  top-K catalog under the caller's roles, filter to candidates outside the
  skill's `toolIds`, and force full retrieval on a hit.
- ~~**Container-tool identity gate** (ADR 0032 §5)~~ — **moved to A4.** The gate
  itself is small, but it needs a resolved token turned into a Secret
  reference, which is precisely the credential plumbing A4 builds (and which
  A4 shapes deliberately so a value never enters workflow state). Today's
  `GetIdentityLink` activity returns no tokens at all and says so in its own
  comment. Doing a half-version here would be work A4 deletes.

### A8. Docs

- New `docs/adr/0002-upstream-integration.md` recording D1–D4.
- ADR 0001: mark milestone 8, and correct §6 — NATS is no longer dropped
  wholesale (D2).
- `docs/pod-agents.md`: gap #1 is **closed upstream**; gap #2 is replaced by the
  NATS bridge.
- README component table.

### A9. NATS pod-agent bridge · the D2 workstream

Largest new surface, and what lets `claude-code-swe-agent` run unchanged.

- `internal/agentrun`: create an `AgentRun` CR; a worker-side subscriber
  translates `ready/progress/reply/failed` and `tool_call` up-messages into
  workflow signals, and workflow commands into `prompt/cancel/signal`,
  `tool_result` and `reply_ack` down-messages.
- Sub-agent `tool_call` → the A6 dispatch helper → `tool_result`.
- **`reply_ack` is acked on receipt.** ADR 0033's hold exists because the
  orchestrator holding the wait can die and core NATS has no durability. A
  Temporal workflow's wait *is* durable, so the buffer has nothing to buffer
  against: set `AGENT_REPLY_ACK_TIMEOUT_MS` low and ack immediately. ADR 0033's
  own last line calls this out — "`AGENT_REPLY_ACK_TIMEOUT_MS=0` is the switch
  that retires it."

  Caveat to verify, not assume: the *bridge process* is not the workflow. A
  crash between "NATS delivered the reply" and "signal accepted by Temporal"
  still loses it. Ack **after** the signal is accepted, and treat duplicate
  `seq` re-offers as idempotent — ADR 0033 already guarantees a re-offer reuses
  its original `seq` precisely so a consumer can tell.

---

## Phase B — land the engine in agent-controller

### B1. Import
`git subtree add --prefix engines/temporal <local durable-agents>` — history and
ADR 0001 preserved. Self-contained Go module. Add two images (worker, gateway)
to `skaffold.yaml` and `release.yml`'s matrix, and `go build/test/vet` to
`ci.yml`.

### B2. The switch
`AGENT_ENGINE=langgraph|temporal` in agent-orchestrator's config, defaulting to
`langgraph`. The two call sites in `server.ts` branch between
`buildAgentGraph().invoke(...)` and a `TemporalEngineClient.runTurn(...)` doing
update-with-start.

Everything outside the graph is shared and untouched: identity resolution,
sender assertion, the Kubernetes-Secret credential store, both launchers,
session pages, the OpenAI facade, `isInternalUiTaskRequest`.

Per D3 and A4, the orchestrator runs the authorization pre-flight **before**
starting the turn and passes the verdict — a Secret *name*, never a value —
into the workflow. One authorization owner, and no credentials in Temporal
event history.

### B3. Chart
New `charts/agent-controller/charts/temporal-engine` subchart (worker + gateway),
`condition: temporal-engine.enabled`, default off. It takes a Temporal
**address** — the platform already runs a cluster, so no server is bundled and
no new stateful component appears. Add it to `values-ci-all.yaml` so
`validate-crds` renders it.

### B4. CRDs and RBAC
No new CRDs — `ToolRunSpec.secretEnv` and `Tool.identityProviders` already
exist. Confirm the worker's ServiceAccount matches the orchestrator's existing
grants: `toolruns` create/get, `agentruns` create/get, `tools`/`skills`/`agents`/
`integrationroutes` get/list/watch, `secrets` create/patch.

### B5. Parity gate
The existing `e2e/specs` suite is the acceptance test — run it whole under
`AGENT_ENGINE=temporal`. Two expectations, stated separately because they are
judged differently:

- Everything else must pass **unchanged**. A failure is a real parity gap.
- `resilience` / `rollout-recovery` should **change behaviour for the better**.
  ADR 0033's "the interrupted turn itself is still lost" should stop holding, so
  those specs need re-baselining rather than passing as written. That
  re-baselining *is* the evidence for the PR.

### B6. ADR
`docs/adr/0036-temporal-execution-engine.md`, adapted from ADR 0001 plus D1–D4,
explicitly naming what it retires or amends: 0002 (LangGraph), 0006 (in-memory
invocation map), 0012/0017 (session store), 0033 (reply-ack hold), and partially
0034 (session pages in an ephemeral Redis).

### B7. PR sequence
Not one PR:

1. subtree import + CI/build wiring — no behaviour change
2. `AGENT_ENGINE` switch + engine client, default `langgraph` — no behaviour change
3. chart subchart, default off
4. e2e under the flag + ADR 0036
5. flip the default — the maintainer's call, on their evidence

---

## Open questions for the maintainer

1. ~~**Temporal as a dependency.**~~ **Answered 2026-08-02: the platform already
   runs Temporal.** The subchart takes an address; no server is bundled and no
   new stateful component is introduced. This was the strongest argument against
   the change and it does not apply.
2. **Does the reply-ack hold get retired, or kept as belt-and-braces?** A9 argues
   it can be acked on receipt under Temporal. Keeping it costs nothing but keeps
   a mechanism alive that no longer has a failure to prevent.
3. **Session pages** (ADR 0034's unfixed follow-up: links posted into GitHub
   comments, opened days later, backed by an ephemeral Redis). Workflow state
   could hold these. In scope, or a separate fix?
4. **Checkpoint-resume's future.** With D2 keeping the NATS path, is the
   step-tool contract worth keeping as a second way to write an agent, or does
   it get dropped to reduce surface area?
