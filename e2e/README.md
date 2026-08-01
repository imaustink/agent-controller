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
| GitHub webhooks | Signed locally by `support/webhook.ts` | The signature path is real (same HMAC the gateway verifies); only the sender is us. |
| Anthropic / Claude Code CLI | `stub-agent` image (`apps/stub-agent`) | A real agent run needs a real paid credential and makes the test slow and nondeterministic — and in a cluster holding no credential it never reaches a terminal phase at all, which is why the happy-path spec was once skipped. The stub speaks the **real** NATS agent protocol and declares the **same** `identityProviders` as the agent it stands in for, so everything between the webhook and the reply — routing, RBAC, the identity gate (including its refusal to launch), AgentRun creation, secret injection, the callback — is exercised for real. |
| OpenAI (planner/selector) | Real, against the dev key | Routing decisions are part of what we're testing. Tests assert on deterministic `IntegrationRoute` dispatch rather than on RAG retrieval, so model nondeterminism doesn't make them flaky. |

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
./scripts/dev-up.sh                 # bring the stack up (skaffold run)
npm run e2e -w e2e                  # or: npx vitest run --config e2e/vitest.config.ts
```

Tests are **serial** (`fileParallelism: false`, `maxConcurrency: 1`): they
share one cluster, and several assert on global state (Redis keys, AgentRun
lists) that concurrent runs would race on.

## Layout

```
support/
  guard.ts          context safety check — imported by every CLUSTER spec
  k8s.ts            kubectl wrappers, waitFor helpers, port-forwarding
  redis.ts          reads credential/session keys out of the orchestrator's Redis
  qdrant.ts         reads the orchestrator's Qdrant: which collection holds which points
  webhook.ts        HMAC-signs and posts GitHub webhook payloads
  chat.ts           drives the CHAT entry point (per-user JWT + streaming /v1/chat/completions)
  invoke.ts         drives the PROGRAMMATIC entry point (accept-then-poll /invoke)
  openwebui-jwt.ts  chat.ts's cluster-free half: JWT minting, SSE assembly
  fixtures.ts       per-test namespace-scoped setup/teardown
  resilience.ts     paces the stub's turn, and DISRUPTS the cluster (NATS, rollouts)
specs/
  happy-path.e2e.ts       webhook -> triage -> AgentRun -> comment posted
  identity-keying.e2e.ts  which subject each entry point keys credentials under
  caller-tools.e2e.ts     consumer-supplied tools: real Qdrant queries + the tool_calls round trip
  chat-harness.e2e.ts     the harness's own signing/SSE parsing, vs. the real product (no cluster)
  waitfor-guard.e2e.ts    waitFor's own bounded-probe guarantee (no cluster)
  resilience.e2e.ts       what survives NATS/orchestrator moving mid-turn
manifests/
  fake-github.yaml          in-cluster GitHub API stub (Deployment + Service + script)
  caller-tool-skills.yaml   two Skill CRs differing only in `allowCallerTools`
```

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
