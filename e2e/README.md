# End-to-end tests

System tests that exercise the **real deployed stack on minikube** —
integration-gateway, agent-orchestrator, Redis, NATS, the CRD controllers and
a real AgentRun — over real HTTP and real Kubernetes objects. Nothing in here
mocks a component this repo owns.

These exist because the failures that actually reach production are
cross-component wiring failures, and unit tests are blind to every one of
them: which Redis key a credential lands under, which order an Agent's
`identityProviders` resolve in, which env vars survive onto the launched Pod,
whether the gateway's `waitAndResume` blocks on the same subject the graph
stored. Every one of those has shipped broken at least once (PRs #144/#145,
#152, #153, #156) and every one was invisible to `vitest` in `apps/*`.

## Safety: these only ever run against minikube

`support/guard.ts` aborts any spec that touches the cluster unless `kubectl
config current-context` is exactly `minikube`. This is not a convenience check — the
default context on the maintainer's machine is a **live cluster**, the tests
create and delete namespaced objects, and a suite that silently ran there
would be destructive. The guard runs before any fixture, and there is
deliberately no environment variable to override it.

## What's stubbed, and why only this

Third-party services are stubbed; nothing else is.

| Dependency | Treatment | Why |
| --- | --- | --- |
| A consumer's own tools | The test IS the consumer | Caller-supplied tools (ADR 0035) are executed by the client, not by this cluster, so a spec sending `tools` and running the returned call itself is not a stub — it is the real other half of the contract. `support/chat.ts`'s `chatToolTurn` sends a full `messages` array precisely so it can resume by resending the result the way a real client does. |
| GitHub REST API | `fake-github` in-cluster service | Tests must assert *what we posted* (comments, labels) without writing to a real repo, and must serve deterministic `/user` + permission responses. Pointed at via the existing `githubApiUrl` value — no production code changes. |
| Inbound events (GitHub, Slack, a CI notifier, any HMAC sender) | Signed locally by `support/webhook.ts` | Every verification scheme is real -- `hmacSha256`, `slackV0`, `bearer`, the tick's ServiceAccount token -- with the same construction the third party uses and the Secret the deployed EventSource names; only the sender is us. |
| Whatever a `reply.http` posts to | `fake-sink` in-cluster recorder (`manifests/fake-sink.yaml`) | Records the raw body + headers so a spec recomputes `x-event-signature` over the exact bytes sent. Pointed at via the triggers' literal `reply.http.url` in values-e2e.yaml -- no product code knows it exists. |
| A public web page (web-fetch's target) | Real `https://example.com/`, skippable with `E2E_NO_EGRESS=1` | web-fetch's SSRF guard refuses every cluster-internal address by design, so "the reply carries the fetched page" has no hermetic version. The hermetic half asserts the guard REFUSES fake-sink's page. |
| Anthropic / Claude Code CLI | `stub-agent` image (`apps/stub-agent`) | A real agent run needs a real paid credential and makes the test slow and nondeterministic — and in a cluster holding no credential it never reaches a terminal phase at all, which is why the happy-path spec was once skipped. The stub speaks the **real** NATS agent protocol and declares the **same** `identityProviders` as the agent it stands in for, so everything between the webhook and the reply — routing, RBAC, the identity gate (including its refusal to launch), AgentRun creation, secret injection, the callback — is exercised for real. |
| OpenAI (planner/selector) | Real, against the dev key | Routing decisions are part of what we're testing. Tests assert on deterministic `EventTrigger` dispatch (a forced `agentRef`/`skillRef`/`toolRef`) rather than on RAG retrieval, so model nondeterminism doesn't make them flaky. |

The line is: **stub what we don't own and can't make deterministic; run
everything we do own for real.** A happy-path test that stubbed the
orchestrator would not have caught any bug from this month.

Two fixtures are *seeded* rather than stubbed, both for the same reason — the
real thing needs a human and a paid third party, and the code path under test
only ever reads back the part we seed:

| Fixture | Seeded by | What stays real |
| --- | --- | --- |
| A linked Claude credential | `support/credential-store.ts`'s `seedClaudeCredential` | Everything downstream: which subject the gate reads, whether it launches, what it injects. Asserting "a credential appears" is impossible hermetically, so the assertion is inverted — seed at the subject the gate is believed to use, and require a LAUNCH. A gate looking elsewhere finds nothing and parks. |
| A linked GitHub account | `support/credential-store.ts`'s `seedGithubLink` | The orchestrator reads only `githubLogin` off that record to resolve a principal (ADR 0031), so a seeded link drives the identical path a real OAuth round trip would produce. |

## Both entry points, not just webhooks

The suite drove only GitHub webhooks until ADR 0031, and that gap has a
scalp: credential convergence (ADR 0029) shipped working in **one direction**.
The webhook path always carries a verified `senderLogin` and so always resolved
a principal; chat had no way to learn a login and silently kept keying by its
own `openwebui:<id>` subject. Every unit test passed, the webhook specs passed,
and the bug was reported from chat.

`support/chat.ts` closes it: it mints the per-request JWT Open WebUI signs
(`X-OpenWebUI-User-Jwt`) and posts a **streaming** `/v1/chat/completions`, which
is what makes the caller per-user and gives the turn the live channel the real
chat surface has. `chat-harness.e2e.ts` checks that minting against the
orchestrator's own resolver and needs no cluster, so a harness/product drift
fails fast instead of surfacing as "could not resolve caller identity" inside
every chat spec.

A rule worth keeping: **when a behaviour differs per entry point, cover it from
each of them.** Every keying bug in this repo's history has been an asymmetry
between the two.

`support/invoke.ts` is that rule applied to the third entry point — the
programmatic accept-then-poll `/invoke` (ADR 0006), driven directly rather than
through a gateway relay. Caller-supplied tools are the behaviour that needed it:
both facades may *offer* tools, only the chat facade can *resume* from their
results, and `/invoke` translates a pending call differently (`pendingToolCalls`
on the polled record, not `tool_calls` on a message). A documented asymmetry with
nothing asserting it is just a claim.

## Running

```bash
kubectl config use-context minikube
./e2e/scripts/up.sh                 # bring the stack up (Temporal engine, the chart default)
npm run e2e -w e2e                  # or: npx vitest run --config e2e/vitest.config.ts
```

Tests are **serial** (`fileParallelism: false`, `maxConcurrency: 1`): they
share one cluster, and several assert on global state (Redis keys, AgentRun
lists) that concurrent runs would race on.

### Per engine

agent-orchestrator drives turns with one of two engines (docs/adr/0036):
`temporal` (the chart default -- `AGENT_ENGINE=temporal`, the Go worker) or
`langgraph` (`AGENT_ENGINE` unset, the in-process loop). `E2E_ENGINE` selects
one for BOTH the deploy and the run:

```bash
E2E_ENGINE=langgraph ./e2e/scripts/up.sh       # clears agentEngine on the release after skaffold
E2E_ENGINE=langgraph npm run e2e -w e2e

E2E_ENGINE=temporal ./e2e/scripts/up.sh        # or plain ./e2e/scripts/up.sh
E2E_ENGINE=temporal npm run e2e -w e2e
```

`support/engine.ts` reads the engine off the deployed orchestrator and, when
`E2E_ENGINE` is set and disagrees, **fails** rather than reporting parity it
never measured. Without `E2E_ENGINE` the suite runs against whatever is deployed
and names it in each event-trigger `describe`.

The specs are engine-agnostic wherever the contract says behaviour is
identical (all of `event-triggers-*`: matching happens in agent-orchestrator in
both modes, and the Temporal engine is handed the resolved turn). Engine-only
behaviour is gated with `describe.skipIf(!isTemporal())`:
`bridged-agent-workflow` (asks the Temporal server), `repo-read-gate` (a Temporal
authz feature LangGraph does not have) and knowledge-base-retrieval's "the Go
engine served them". The one engine-specific expectation inside an event spec
is where a session id is OBSERVABLE (the LangGraph launcher annotates the
AgentRun with it; the Temporal launcher does not), noted where it is asserted.

Other knobs: `E2E_NO_EGRESS=1` skips the one spec that needs the public
internet; `E2E_SKIP_WEB_FETCH_BUILD=1` skips building the web-fetch image in
`up.sh`; `E2E_KEEP_AGENT_RUNS=1` keeps AgentRuns after a green run.

## Layout

```
support/
  guard.ts          context safety check — imported by every CLUSTER spec
  k8s.ts            kubectl wrappers, waitFor helpers, port-forwarding
  redis.ts          reads credential/session keys out of the orchestrator's Redis
  qdrant.ts         reads the orchestrator's Qdrant: which collection holds which points
  webhook.ts        signers + posters for every EventSource scheme (hmacSha256, slackV0,
                    bearer), the tick poster, and payload builders (GitHub, Slack, CI, URL)
  events.ts         event-trigger harness: gateway forward, source Secrets, per-test
                    EventSource/EventTrigger CRs + Ready waits, /invoke with an envelope,
                    AgentRun/ToolRun readOnly+params readers, fake-github issue activity
  fake-sink.ts      reads fake-sink's recording; verifies x-event-signature
  engine.ts         which engine is deployed; enforces E2E_ENGINE
  chat.ts           drives the CHAT entry point (per-user JWT + streaming /v1/chat/completions)
  invoke.ts         drives the PROGRAMMATIC entry point (accept-then-poll /invoke)
  openwebui-jwt.ts  chat.ts's cluster-free half: JWT minting, SSE assembly
  fixtures.ts       per-test namespace-scoped setup/teardown
  resilience.ts     paces the stub's turn, and DISRUPTS the cluster (NATS, rollouts)
specs/
  happy-path.e2e.ts       webhook -> triage -> AgentRun -> comment posted (credential env)
  event-triggers-github.e2e.ts        ai-triage: forced agent, writable, params, ack->result->label off; also on FAILURE
  event-triggers-readonly.e2e.ts      ai-review (issue + PR): readOnly on CR/Job/process; PR triage control; STICKY per session
  event-triggers-filtering.e2e.ts     accepted-but-ignored deliveries + bot/unresolved senders; ends with a positive control
  event-triggers-verification.e2e.ts  401/404 per scheme (each paired with a 202), Slack challenge + staleness, tick auth
  event-triggers-reply-http.e2e.ts    slack->orchestrator, ci->forced skill, generic-hmac->web-fetch; signed reply.http
  event-triggers-cron.e2e.ts          CronJob materialization, a manual tick -> read-only run, scheduler + suspend/delete
  event-triggers-invoke.e2e.ts        /invoke {event}: ignored / 422 / 202, session ids, priority + tie-break, examples rendered
  event-triggers-status.e2e.ts        Ready reasons, NotReady never matches (and recovers), admission, readOnly on the CRs
  label-durability.e2e.ts the trigger label comes off on failure and across a gateway restart
  identity-keying.e2e.ts  which subject each entry point keys credentials under
  identity-continuity.e2e.ts  a parked chat turn never resumes as anyone but its own caller
  repo-read-gate.e2e.ts   a GitHub-acting agent launches only into a repository its caller can read
  caller-tools.e2e.ts     consumer-supplied tools: real Qdrant queries + the tool_calls round trip
  chat-harness.e2e.ts     the harness's own signing/SSE parsing, vs. the real product (no cluster)
  waitfor-guard.e2e.ts    waitFor's own bounded-probe guarantee (no cluster)
  rbac-parity.e2e.ts      markers -> role.yaml -> Helm chart RBAC agree (no cluster)
  rbac-installed.e2e.ts   the INSTALLED ClusterRole, and that the controller starts
  resilience.e2e.ts       what survives NATS/orchestrator moving mid-turn
  mcp-broker-contract.e2e.ts  MCP engine client <-> broker server <-> Go activity agree (no cluster)
  mcp-crd.e2e.ts          the deployed mcp-broker discovers the fake MCP server and proxies a call as the caller
manifests/
  fake-github.yaml          in-cluster GitHub API stub (Deployment + Service + script)
  fake-sink.yaml            in-cluster recorder for reply.http + a static page web-fetch must refuse
  event-trigger-skill.yaml  the Skill ci-failure-skill forces here (a fixed-receipt skill)
  caller-tool-skills.yaml   two Skill CRs differing only in `allowCallerTools`
```

## Event triggers (ADR 0048)

`EventSource` (how an event arrives and is trusted) + `EventTrigger` (CEL match
-> one target, structured params, declarative side-effects) replaced
`IntegrationRoute`. The contract is `docs/event-triggers.md`; the specs are
written against it, not against either implementation.

**What values-e2e.yaml turns on.** Every example source (`github`, `slack`,
`ci`, `generic-hmac`, and `nightly-sweep` SUSPENDED) and every example trigger,
retargeted for a hermetic cluster: the GitHub triggers at the stubs (so the
`readOnly=<bool> params=<json>` line `apps/stub-agent` prints is observable),
`ci-failure-skill` at a fixture Skill, and `reply.http` of the ci and
generic-hmac triggers at fake-sink with a signing secret. The Slack example has
no `reply` (no Slack reply adapter exists), so its reply.http path is covered
by a per-test, higher-priority twin and its own selection through `/invoke`.

**The matrix.**

| Concern | Where |
| --- | --- |
| issue labeled ai-triage -> writable run, ack before result, label removed, also on failure | `event-triggers-github` |
| ai-review (issue, PR) -> `spec.readOnly`, `AGENT_READ_ONLY=true`, stub line; triage controls `readOnly=false` | `event-triggers-readonly`, `event-triggers-github` |
| readOnly sticky: a later triage label and a session-page follow-up on a reviewed session | `event-triggers-readonly` |
| non-matching deliveries, Bot sender, unresolvable sender -> 202, no run, no comment | `event-triggers-filtering` |
| bad/missing signature per scheme -> 401; unknown/wrong-kind source -> 404; Slack challenge; stale Slack ts; tick auth | `event-triggers-verification` |
| slack -> orchestrator; ci (bearer) -> forced skill; generic-hmac -> web-fetch tool; signed reply.http | `event-triggers-reply-http` |
| cron: CronJob + ServiceAccount shape/ownership/projected token, a tick -> read-only run with payload params, schedule/suspend/delete | `event-triggers-cron` |
| /invoke with an envelope: ignored / 422 / 202; session id rules; priority; equal-priority tie-break | `event-triggers-invoke` |
| Ready reasons (InvalidCEL, TargetNotFound, SourceNotFound, SecretNotFound, SecretKeyMissing, InvalidSchedule) and fail-closed matching | `event-triggers-status`, `event-triggers-cron` |
| RBAC for the new kinds (core-controller, gateway, orchestrator) | `rbac-parity` (no cluster), `rbac-installed` |

**Patterns these specs rely on -- keep them when adding one.**

- *Every absence is paired with a presence.* A 401 next to a 202 under the same
  secret; "no run" in a window followed by a control that DOES run in that
  window; "NotReady never matches" followed by the same trigger, fixed,
  matching. An absence alone passes for any broken reason.
- *Find runs by params, not by recency.* `AgentRun.spec.params` is contract on
  both engines (§6), so `waitForAgentRunWithParam(since, "number", n)` cannot
  pick up a straggler from an earlier test.
- *Wait for the orchestrator to SEE a per-test trigger, not just for Ready.*
  `waitForTriggersLoaded` applies a probe trigger whose params always fail, and
  polls `/invoke` until it answers 422 -- the informer has then delivered
  everything applied before it, and a 422 starts no turn.
- *Per-test triggers match only their own run id* (`body.e2eInvoke == "<id>"`),
  on the `generic-hmac` source, so they can never capture another spec's event.
- *Signatures are recomputed over recorded raw bytes*, and checked to FAIL
  under a different secret.

**Out of scope here**: a cron source while `EVENT_TICK_URL` is unset
(`TickNotConfigured`) needs a differently-configured controller and is covered
by core-controller's envtest suite; the SWE agents' enforcement of read-only
(denying `git push`, minting a contents:read token) is covered by their own
vitest suites -- the cluster can only show the flag arrives.

### `caller-tools.e2e.ts` is the only thing that validates the Qdrant filter DSL

`apps/agent-orchestrator`'s unit tests mock the Qdrant client outright, which
means they prove *which method the code meant to call* and nothing about whether
the query is valid. Caller-supplied tools (ADR 0035) added three hand-written
filter shapes — `has_id` for the id-restricted search, a payload-only
`setPayload` for cache-hit touches, and a delete-by-filter `range` for the TTL
sweep — and a mock accepts all three whether or not Qdrant would.

That matters more than it sounds. `has_id` **is** the isolation boundary for the
caller-tool collection: it has no RBAC payload filter, because a caller both
supplies and executes their own function, so a mis-shaped filter is not just a
500 but a cross-caller leak. And the `range` sweep is the only thing bounding a
collection Qdrant gives no native TTL. Its first describe block therefore drives
the real `QdrantCallerToolStore` against the real Qdrant, in **its own throwaway
collection** (never the deployment's), with a deterministic stand-in embedder —
the subject is the filter DSL, and paying for real embeddings would add cost and
nondeterminism to assertions that never look at similarity quality.

The second block asserts the claim no unit test can see: a caller's definitions
land in `caller_tools` and the `tools`/`skills`/`agents` point counts do not
move.

Two things worth knowing before editing it:

- **It seeds two Skill CRs, and the planner decision is deliberately made
  deterministic.** Whether the planner *calls* a caller tool is a real OpenAI
  decision, and this suite's rule is to assert on deterministic dispatch rather
  than model judgement. A skill's markdown is trusted system-prompt content — the
  strongest lever over that decision short of faking the planner — so
  `manifests/caller-tool-skills.yaml` instructs one skill to always call the
  caller's tool and gives its `allowCallerTools: false` twin an explicit
  no-tool branch to take instead. Asserting that branch (not merely "no tool call
  happened") is what separates the gate working from the model declining anyway.
  Both descriptions are narrow to the point of uselessness so they can't win
  retrieval in other specs, and `afterAll` deletes them.
- **`values-e2e.yaml` sets `callerToolTopK: 3`** (production defaults to 5). The
  threshold, not the number, is the interesting boundary: below it the
  just-in-time index is skipped entirely, above it a turn embeds, upserts and runs
  the filtered search. A smaller K makes both sides reachable with fewer tools,
  which is fewer real embedding calls per test.

### `rbac-parity.e2e.ts` covers the chain no single change touches end to end

core-controller's permissions are written once as `+kubebuilder:rbac` markers
and then copied twice — `make manifests` into `config/rbac/role.yaml`, a human
into the Helm chart's ClusterRole. Only the chart's copy is ever installed, and
a copy that is skipped fails the same way every time: the manager cannot list a
kind it watches, the informer never syncs, `Failed to run manager` ends the
process, and the pod crashloops.

Nothing else reports it. An AgentRun submitted against a controller that never
started is accepted and left in no phase, and the caller sees `went silent for
600000ms after 0 progress message(s)` — ten minutes of nothing, naming neither
RBAC nor the controller. That is how `Add Connection and KnowledgeBase CRDs`
shipped: role.yaml regenerated with both new kinds, the chart's ClusterRole —
the one its own comment promises is "kept in lockstep" — left with the previous
eight.

The spec compares the three as flat `group/resource:verb` triples, because each
expresses the same permissions in a different grouping and a rule-by-rule diff
reports reorderings as differences. It reads the **markers**, not role.yaml, as
the authority: the generated file is itself an artifact someone has to remember
to regenerate. It also asserts the chart grants nothing *beyond* the markers —
this ClusterRole is the only thing in the system holding `batch/jobs`
create+delete (ADR 0010).

`rbac-installed.e2e.ts` is the last link, and the only part needing minikube: a
correct chart does not make a correct cluster, since a release predating the fix
keeps serving the old ClusterRole until someone upgrades it.

### Every wait is bounded, and that is not decoration

Two rules the harness now enforces, both written down because breaking either
produced a failure that looked like a product bug and cost a full run to
disprove:

1. **`waitFor` bounds every probe attempt.** It used to `await probe()`
   unbounded, which made `timeoutMs` *unreachable* whenever a probe failed to
   settle — the loop stopped forever without re-checking its own deadline. That
   is reachable: probes `fetch` through a `kubectl port-forward`, Node's `fetch`
   has no default timeout, and a forward dropped by a busy apiserver leaves a
   socket nobody answers. A resilience run sat at **0% CPU for eight minutes** on
   exactly this — no processes, no sockets, no output — until vitest's per-test
   timeout killed it and reported "the test timed out", which says nothing about
   which hop stalled. Hung attempts are now counted and reported separately from
   failed ones, because "all attempts hung" and "the condition was never true"
   have different fixes. `specs/waitfor-guard.e2e.ts` pins this, with no cluster.
2. **Never call `fetch` directly against a cluster service — use
   `fetchThrough(forward, path)`.** It bounds the request *and* reports whether
   the port-forward died mid-flight, so a dropped forward reads as a dropped
   forward instead of as a service that went quiet. `withPortForward` hands
   `body` the forward as its second argument for precisely this; pass it along
   rather than closing over `baseUrl` alone.

The practical payoff is that a dropped forward now fails one poll and the next
poll gets a fresh forward, instead of wedging the entire run.

### `resilience.e2e.ts` disrupts the cluster on purpose

It deletes the NATS pod and rolls the orchestrator **while an agent turn is in
flight**, then asserts the turn survives and that the orchestrator reports the
truth about it. That is the only way to cover the failure this suite was
extended for: a run that succeeded while the chat said `produced no reply within
3660000ms`, because a bound that was never armed, a shutdown that drained NATS
under an in-flight request, and a catch-all that relabelled every error as a
timeout all lined up. None of it is reachable without a real NATS server and a
real SIGTERM.

Two consequences worth knowing before editing it:

- **It needs a slow turn.** The stub replies in milliseconds, which leaves no
  window to disrupt anything, so `apps/stub-agent` takes pacing env vars
  (`pacing.ts`) and the spec PATCHES them onto the `stub-agent` Agent CR per
  test. `afterAll` resets them — leaving pacing on the CR makes every later
  spec slow, and a leftover silent phase makes them fail outright.
- **It needs a short idle window.** `values-e2e.yaml` sets
  `agentIdleTimeoutSeconds: 20` (production defaults to 10 minutes) so a test
  can wait out a genuinely silent agent. The window bounds *silence*, not
  duration, so this does not cap how long a run may take — one of the specs
  asserts exactly that by pacing a narrating turn to five times the window and
  expecting it to succeed.

`stub-agent` is NOT here: it is a real image (`apps/stub-agent`) built by the
skaffold `e2e` profile, and its Agent CR is a chart template
(`charts/community-components/templates/agent-stub.yaml`) enabled by
`values-e2e.yaml`. Keeping it in the chart rather than in a hand-applied
manifest is the point — the CR the suite exercises is produced by the same
templating production uses, so a change that breaks Agent rendering breaks the
e2e run too.

### Editing `fake-github.yaml`

Its script is a mounted ConfigMap, and a running `node` process does not re-read
a mounted file. `ensureFakeGithub()` therefore substitutes a hash of the whole
manifest into the pod template's `e2e.controller-agent.dev/config-checksum`
annotation, so an edited script changes the pod spec and the Deployment rolls by
itself. Do not replace that with `kubectl rollout restart` after the apply: the
restart can beat the ConfigMap write it was meant to pick up, which is how a
readiness-probe fix to that file once appeared to have no effect at all.
