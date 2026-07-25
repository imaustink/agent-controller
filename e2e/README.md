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

`support/guard.ts` aborts the whole suite unless `kubectl config
current-context` is exactly `minikube`. This is not a convenience check — the
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
| Anthropic / Claude Code CLI | `stub-agent` image | A real agent run needs a real paid credential and makes the test slow and nondeterministic. The stub speaks the **real** NATS agent protocol, so everything between the webhook and the reply — routing, RBAC, the identity gate, AgentRun creation, secret injection, the callback — is exercised for real. |
| OpenAI (planner/selector) | Real, against the dev key | Routing decisions are part of what we're testing. Tests assert on deterministic `IntegrationRoute` dispatch rather than on RAG retrieval, so model nondeterminism doesn't make them flaky. |

The line is: **stub what we don't own and can't make deterministic; run
everything we do own for real.** A happy-path test that stubbed the
orchestrator would not have caught any bug from this month.

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
  guard.ts       context safety check — imported by every spec
  k8s.ts         kubectl wrappers, waitFor helpers
  redis.ts       reads credential/session keys out of the orchestrator's Redis
  webhook.ts     HMAC-signs and posts GitHub webhook payloads
  fixtures.ts    per-test namespace-scoped setup/teardown
specs/
  happy-path.e2e.ts       webhook -> triage -> AgentRun -> comment posted
  identity-keying.e2e.ts  which subject each entry point keys credentials under
manifests/
  fake-github.yaml   in-cluster GitHub API stub (Deployment + Service + script)
  stub-agent.yaml    Agent CR + image that speaks the NATS protocol and replies
```
