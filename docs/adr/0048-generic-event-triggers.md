# 0048. `EventSource` + `EventTrigger`: generic event-driven dispatch

Date: 2026-10-13

## Status

Proposed. Supersedes ADR 0024 (`IntegrationRoute`). Amends ADR 0025 (triage
"starting work" comment + session page become declarative, not hardcoded).

> Provisional number: 0047 is reserved by the in-flight framework/orchestrator
> split; renumber at merge if that lands first.

## Context

ADR 0024 introduced `IntegrationRoute` to dispatch an inbound integration event
to a target by id, bypassing RAG. In practice it drifted into exactly the narrow,
hardcoded thing it set out to avoid, and the `ai-triage`/`ai-review` flows are the
evidence:

- **Ingestion is GitHub-only and label-only.** `apps/integration-gateway`'s
  `parseGithubEvent` special-cases exactly two actionable shapes
  (`issues.labeled`, `pull_request.labeled`) and drops everything else. Adding
  any other source — Slack, a CI webhook, Stripe, a timer — means new gateway
  code, not a new CR.
- **The match is a rigid exact-equality table.** `match` is
  `source`/`event`/`action`, with `labelName` bolted on as an amendment the
  moment one `source/event/action` triple had to carry two intents. Every new
  distinguishing value in a payload demands a new typed field, a registry
  specificity tweak (`action*2 + labelName`), and a matching gateway change.
- **The only parameter channel is one `promptTemplate` string.** There is no
  structured params, and no "orchestrator / subagent / tool, each with custom
  parameters" target beyond a single ref + a rendered string. This is why
  review-only mode is smuggled as a magic `SWE-ENFORCED-MODE: review-only`
  sentinel that must be byte-identical in four places (`claude.ts`,
  `opencode.ts`, and both review route templates) and grepped back out by
  `isReviewMode(goal)` — a core write-gate riding on a prompt string surviving
  intact, exactly the anti-pattern the repo elsewhere avoids by plumbing
  structured signals deterministically.
- **Triage vs review is two env vars and an if/else.**
  `GATEWAY_GITHUB_TRIGGER_LABEL` / `GATEWAY_GITHUB_REVIEW_LABEL` compared in the
  gateway, which must be kept in lockstep with each route's `match.labelName`.
- **Side-effects are hardcoded per flow.** Upfront ack comment, result reply,
  trigger-label self-clear, and the session page are all gateway code gated on
  "is this the labeled path," not declared anywhere.

The original ask was never "GitHub label routing." It was: *define event-driven
behaviors as custom resources* — arbitrary event shapes in, dispatching the
orchestrator, a skill, a subagent, or a tool, each with custom parameters — with
`ai-triage`/`ai-review` being nothing more than two example CRs.

## Decision

Replace `IntegrationRoute` with two generic CRDs, split by authorship and trust
(the `MCPServer`/`MCPTool`, `Connection`/`Corpus` discipline):

```
EventSource    how events ARRIVE + are trusted      operator-authored, privileged
               (webhook: path/verify/secret, or      one per source
                cron: schedule/payload)

EventTrigger   what an event DISPATCHES              operator-authored
               match (CEL) + target + params         many per source
               + options + side-effects
```

### 1. `EventSource` — discriminated ingestion, one envelope out

`EventSource.spec` is a `oneOf` (CEL-validated, as these CRDs already validate
single-ref unions):

- `webhook { path, verify { scheme, header, secretRef }, dropSenders }` — the
  gateway serves `path`, verifies per `scheme` (`hmacSha256`, `slackV0`,
  `bearer`, `none`) **before** parsing, and normalizes the **entire** payload.
- `cron { schedule, timezone, payload }` — a timer source carrying a static
  `payload`.

Every source — webhook or cron — produces the **same normalized envelope**:

```
event = { source, kind: "webhook"|"cron", time, headers, body, delivery }
```

For a webhook, `body` is the raw parsed payload and `headers` the request
headers; for a cron, `body` is the source's static `payload` and `headers` is
empty. Downstream matching and parameter extraction are identical regardless of
how the event arrived — this is the whole point of normalizing at the source.

The gateway stops filtering: it verifies, normalizes, and relays. No event-type
allowlist, no label env vars, no triage/review branch.

### 2. `EventTrigger` — CEL match, target union, structured params

```yaml
spec:
  match:
    cel: |                      # over the envelope; any source, any shape
      source == "github" && body.action == "labeled"
        && body.label.name == "ai-review"
  target:                       # exactly one of (CEL oneOf):
    orchestratorRef: {}         #   conversational / RAG path (ADR 0007/0024)
    skillRef: <id>              #   force a skill (loadSkillTools bypass)
    agentRef: <id>              #   dispatch a subagent (AgentRun)
    toolRef: <id>               #   one-off tool run (the §4 FAAS path, now built)
    readOnly: true              #   structured option -> AgentRun.spec, NOT a sentinel
    params:                     #   named, CEL-derived from the event
      repo:   "body.repository.full_name"
      number: "body.pull_request.number"
    promptTemplate: |           #   {{param}} substitution, as today
      Review PR {{repo}}#{{number}} ...
  ack:        { github: { comment: "Starting review…", sessionPage: true } }
  reply:      { github: { kind: comment } }
  onComplete: { github: { removeTriggerLabel: true } }
```

**Match is CEL**, evaluated against the envelope. It subsumes
`source`/`event`/`action`/`labelName` and every future distinguishing value with
no schema change, and the operator expresses specificity directly — retiring the
`action*2 + labelName` scoring hack. A trigger whose CEL fails to compile is
`NotReady` and never matches (fail-closed).

**Target is a dispatch union** mirroring the catalog's dispatch-kind pattern,
each carrying structured `params` (CEL-derived) and a `promptTemplate`. `params`
render into the prompt/goal and, for `toolRef`, become the tool's input args
(schema-validated). `orchestratorRef` is the deliberate opt-in to the
conversational/RAG path; **no matching trigger is a clean no-op**, not a RAG
fallback (a Stripe or CI webhook that matches nothing must not be interpreted as
free text).

**`readOnly` is deterministic.** It is carried onto `AgentRun.spec.readOnly` and
read by the SWE agent from its run spec — not from the goal string. The existing
behavior (deny `git push` / `gh pr create|merge|...`, mint a read-only
`contents:read` token) is unchanged; only its trigger moves from a grepped
sentinel to a structured field. `SWE-ENFORCED-MODE: review-only`,
`REVIEW_MODE_MARKER`, and `isReviewMode(goal)` are deleted.

**Side-effects are declarative.** `ack` / `reply` / `onComplete` are optional and
implemented by a per-source **reply adapter** (GitHub first), keyed on the source
— never on "triage vs review." The session page is a GitHub-adapter capability
behind `ack.github.sessionPage`, gated by `GATEWAY_PUBLIC_URL` as today.

### 3. Who reads what

- **Gateway** reads `EventSource` (webhook kind) + referenced Secrets — a small,
  scoped read; the gateway already imports `@kubernetes/client-node`. It serves
  each source's `path`, verifies, normalizes, relays to `/invoke`, and runs the
  source's reply adapter.
- **Orchestrator** (both engines) reads `EventTrigger`, exactly where
  `IntegrationRoute` is read today — `CrdEventTriggerRegistry` +
  `checkEventTrigger` graph node (TS), and the `invoke.go` watch (Temporal).
- **core-controller** reconciles both CRDs for a `Ready` condition, and for a
  `cron` `EventSource` **materializes and owns a k8s `CronJob`** (reusing the
  `batch/cronjobs` RBAC the ToolRun/AgentRun launcher already holds). Each tick
  POSTs the synthesized cron envelope to `/invoke`. This gives exactly-once per
  tick, survives gateway restarts, and needs no leader election — the gateway
  runs `replicaCount` replicas, so an in-process timer would double-fire.
  The tick authenticates with **workload identity, not a shared secret**: each
  cron source also gets an owned ServiceAccount, the CronJob presents a
  projected token for the gateway's audience, and the gateway TokenReviews it,
  accepting only that source's ServiceAccount. A chart-generated shared token
  was tried first and dropped: Helm `lookup` returns nothing under
  `helm template`/Argo CD, so it was regenerated on every render.

### 4. Both engines move in lockstep

The envelope, CEL semantics, target union, param binding, and `readOnly`
plumbing are one shared contract landed together in the Temporal (`cel-go`) and
LangGraph (CEL-for-JS) engines — the ADR 0045 discipline, so a brand-new kind
does not accrue parity debt. The TS CEL evaluator is the one genuinely new
dependency and was de-risked by a spike before anything else (no CEL/JSONPath lib
exists in the workspace today).

**Spike outcome (go):** TS uses `@marcbachmann/cel-js` (zero-dependency,
actively maintained, pinned ≥ 6.x to clear the CVE-2024 prototype-pollution range
2.0.4–5.2.0); the Temporal engine uses `cel-go`. The risk is not availability but
**cross-engine parity**: `cel-go` is fully spec-conformant while the JS impl is
"most of the spec," and both engines must evaluate the same `match.cel`
identically. Mitigated by (a) constraining the CEL surface we actually use to a
documented subset both implementations agree on (equality, `&&`/`||`, index,
`in`, basic string ops) and (b) a shared cross-engine **CEL-parity fixture
suite** — identical inputs, asserted-identical verdicts — run in both engines' CI
and proven able to fail. JSONPath-plus-conditions remains the documented fallback
if parity proves unholdable.

## Consequences

- `ai-triage` and `ai-review` become **example CRs**, not code: an issue/PR
  labeled trigger, a review trigger with `readOnly: true`, and a scheduled
  sweep — shipped alongside a generic-HMAC→tool, a Slack-signed→orchestrator,
  and a CI→skill example, each behind an `enabled` flag.
- A new source is a `kubectl apply`, not a gateway redeploy. A new trigger is a
  CEL predicate. Neither touches the orchestrator graph or the engines.
- The write-gate no longer depends on a prompt string surviving an
  attacker-influenced body; a forged `readOnly` can only *restrict*.
- One-off `toolRef` finally implements the FAAS/direct-invoke path
  `docs/integrations-gateway.md` §4 left open.
- Teardown is real and wide: `IntegrationRoute` (types/controller/registry/
  graph-node), the gateway's GitHub-only parse + label env vars + triage/review
  branches, the four-place review sentinel, and all four
  `integrationroute-*.yaml` chart templates + their values are deleted.
- The gateway's `EventSource` read is a small, scoped RBAC increase; core-
  controller gains `eventsources`/`eventtriggers` grants (hand-synced in
  `rbac.yaml`, enforced by `rbac-parity.e2e.ts`) and already has `batch/cronjobs`.

## Alternatives considered

- **Extend `IntegrationRoute` in place** (add a `conditions` map, keep typed
  `source/event/action`). Smaller diff, but keeps the GitHub shape, the scoring
  hack, and the single-string parameter channel — i.e. it does not solve the
  thing that made this funky. Rejected.
- **JSONPath + conditions instead of CEL.** Lighter dependency, no expression
  engine. Kept as the fallback, not the default: it cannot express boolean
  composition beyond `all`/`any`, which the mixed-source matrix will want.
- **In-gateway cron scheduler.** Simplest to write, but double-fires under
  `replicaCount > 1` and dies with the pod. A reconciler-owned `CronJob` reuses
  existing machinery for exactly-once, HA-safe scheduling. Rejected in favor of
  the CronJob.
- **One combined CRD** (match + verify + schedule in one kind). Conflates the
  privileged, credential-bearing ingestion object with the many cheap dispatch
  objects, and blurs the trust boundary the `MCPServer`/`MCPTool` split keeps
  legible. Rejected.

## Rollout

0. Spike the TS CEL evaluator (go/no-go on CEL vs the JSONPath fallback); land
   this ADR.
1. `EventSource` (discriminated) + `EventTrigger` CRDs + reconcilers (incl.
   `CronSource` → `CronJob`); `make manifests generate`; hand-sync `rbac.yaml`.
2. Gateway: generic ingestion/verification from `EventSource`, GitHub source
   reproduced behind a flag; old path still live.
3. Orchestrator matching + dispatch in **both** engines (lockstep): CEL match,
   target union, params, `readOnly` → `AgentRun.spec`.
4. One-off `toolRef` launch, both engines.
5. SWE agents: structured `readOnly`, delete the sentinel.
6. Declarative `ack`/`reply`/`onComplete` + session page re-homed.
7. Teardown: delete `IntegrationRoute` + hardcoded gateway/chart logic; ship the
   example CRs.
8. E2E matrix (both engines) + docs.
