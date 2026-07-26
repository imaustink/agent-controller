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
| A linked Claude credential | `support/redis.ts`'s `seedClaudeCredential` | Everything downstream: which subject the gate reads, whether it launches, what it injects. Asserting "a credential appears" is impossible hermetically, so the assertion is inverted — seed at the subject the gate is believed to use, and require a LAUNCH. A gate looking elsewhere finds nothing and parks. |
| A linked GitHub account | `support/redis.ts`'s `seedGithubLink` | The orchestrator reads only `githubLogin` off that record to resolve a principal (ADR 0031), so a seeded link drives the identical path a real OAuth round trip would produce. |

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
  k8s.ts            kubectl wrappers, waitFor helpers
  redis.ts          reads credential/session keys out of the orchestrator's Redis
  webhook.ts        HMAC-signs and posts GitHub webhook payloads
  chat.ts           drives the CHAT entry point (per-user JWT + streaming /v1/chat/completions)
  openwebui-jwt.ts  chat.ts's cluster-free half: JWT minting, SSE assembly
  fixtures.ts       per-test namespace-scoped setup/teardown
  resilience.ts     paces the stub's turn, and DISRUPTS the cluster (NATS, rollouts)
specs/
  happy-path.e2e.ts       webhook -> triage -> AgentRun -> comment posted
  identity-keying.e2e.ts  which subject each entry point keys credentials under
  chat-harness.e2e.ts     the harness's own signing, vs. the real resolver (no cluster)
  resilience.e2e.ts       what survives NATS/orchestrator moving mid-turn
manifests/
  fake-github.yaml   in-cluster GitHub API stub (Deployment + Service + script)
```

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
