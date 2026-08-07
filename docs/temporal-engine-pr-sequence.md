# Landing the Temporal engine: the PR sequence

> Working notes for [ADR 0036](adr/0036-temporal-execution-engine.md). Delete
> this file once the sequence has landed.

Five PRs, in order. The first four exist as branches; the fifth deliberately
does not — see below.

Nothing changes behaviour until PR 5. PRs 2–4 add code and configuration that
sit inert behind `AGENT_ENGINE=langgraph` (the default) and
`temporal-engine.enabled=false` (also the default).

| # | Branch | Base | Changes behaviour? |
| - | ------ | ---- | ------------------ |
| 1 | `pr/1-adr-temporal-engine` | `main` | No — docs only |
| 2 | `pr/2-import-engine` | `main` | No |
| 3 | `pr/3-engine-switch` | PR 2 | No (default unchanged) |
| 4 | `pr/4-engine-chart` | PR 3 | No (subchart off) |
| 5 | — not written — | PR 4 | **Yes** |

---

## PR 1 — ADR 0036, on its own

**`pr/1-adr-temporal-engine`** · 1 commit · 2 files, +181

Docs only, and deliberately **not** in the dependency chain: it can be reviewed
and merged in parallel with, or instead of, everything below.

That ordering is a change from the original plan, which put the ADR fourth
alongside the e2e run. Putting it first means the design can be rejected before
anyone reads 17,000 lines of Go. If the answer is "we don't want a second agent
loop", this is the only PR that needed to exist.

CI skips this PR entirely (`paths-ignore: **/*.md`), which is correct.

## PR 2 — Import the engine

**`pr/2-import-engine`** · base `main` · 108 files, +17,396

The engine arrives by `git subtree`, so its seven milestone commits and its own
two ADRs are real history rather than one opaque drop — `git log engines/temporal`
reads as what it is. Also: module renamed to this repo's convention, a CI job,
and three images in the release matrix.

**Touches no TypeScript at all**, so the LangGraph path cannot be affected. Worth
saying in the PR description, because it is the cheapest thing for a reviewer to
verify and it makes the rest of the review lower-stakes.

Reviewing 17k lines is not the ask. The ask is: does this belong in the repo, is
it wired into CI correctly, and is the history intact. The code itself was
reviewed as it was written (see its own ADRs) and its tests run in CI from this
PR forward.

## PR 3 — The `AGENT_ENGINE` switch

**`pr/3-engine-switch`** · base PR 2 · 6 files, +439

`AGENT_ENGINE=langgraph|temporal`, defaulting to `langgraph`. `AgentGraphLike`
was already the Server's dependency, so this is a second implementation of an
existing interface, not a refactor — **581 existing tests pass unchanged**, which
is the claim to check first.

The substantive review is in `engine/temporal-engine.ts`: it is an HTTP client
rather than an embedded Temporal client (three reasons, documented at the top of
the file), it signs the sender login rather than trusting an internal hop, and it
names an already-matched route target rather than having the engine re-derive it.

## PR 4 — The subchart

**`pr/4-engine-chart`** · base PR 3 · 20 files

`temporal-engine` subchart, `enabled: false`. Takes a Temporal address; bundles
no server.

The part worth actual scrutiny is the RBAC, because the imported chart's grants
predated the catch-up work: `secrets` (the grant that keeps credentials out of
Temporal's event history), `agentruns` (only when the NATS bridge is enabled),
and `integrationroutes` on a new gateway ServiceAccount. Each mirrors a grant
agent-orchestrator already holds.

Also adds the first CI job that renders `charts/agent-controller` at all.

## PR 5 — Flip the default

**Not written, on purpose.**

Its precondition is the e2e suite run whole under `AGENT_ENGINE=temporal`
(needs minikube, a reachable Temporal, and the images built). Writing a
"flip the default" PR before that evidence exists would be asserting a result
nobody has.

Two expectations, judged differently:

- Everything else must pass **unchanged**. A failure is a real parity gap.
- `resilience` and `rollout-recovery` should **change for the better**. They
  encode losses that stop occurring — ADR 0033's "the interrupted turn itself is
  still lost" among them — so they need re-baselining rather than passing as
  written. That re-baselining is the evidence, not a workaround.

Also unverified until CI runs: the three engine images have never been built (no
Docker daemon in the environment they were prepared in). Contexts are
self-contained and `go build ./...` passes natively, but PR 2's first CI run is
what proves the Dockerfiles.

---

## Three findings worth acting on independently

Each stands on its own merits whether or not the engine is ever enabled:

1. **The identity gate is skipped for sub-agent tool calls** on the LangGraph
   path. ADR 0032 §5 gates the planner's `runTool`, but `dispatchResolvedTool`
   has no equivalent — so a Tool meant to act as a specific human runs with
   whatever static token its template carries. Fixed in the engine; worth fixing
   here too.
2. **No CI job renders `charts/agent-controller`.** A broken template in any of
   its four subcharts ships silently. PR 4 covers the new one; the other three
   remain unguarded.
3. **The two engines' Qdrant payload schemas differ**, so they must never share a
   collection. Hence the `te-` prefix default — worth knowing before anyone
   points both at one instance.
