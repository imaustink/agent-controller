# 0050. Agent observability: OpenTelemetry traces, exported to Langfuse, joined to the launch audit record

Date: 2026-11-11

## Status

Proposed. Companion to [0049](0049-configurable-agent-identity-mode.md)
(identity modes and the `agent-launch` audit record). Builds on the unified
TurnEvent stream (Temporal engine [ADR 0004](../../orchestrator/engines/temporal/docs/adr/0004-unified-lifecycle-event-stream.md), carried in
`framework/protocol/proto/aktis/protocol/v1/turn_event.proto`). Temporal
engine only. The LangGraph engine is frozen (0049).

## Context

Nothing in the system is traced. There is no OpenTelemetry, no Langfuse, and
no LLM-level telemetry in either engine, the agent runtime, or the catalog
agents. The only OpenTelemetry in the repo is indirect Go dependencies. When a
run misbehaves, the evidence is pod logs, which disappear with the pod (see
the agent-pod crash forensics we already had to do), and Temporal workflow
history, which shows activities but not what the model saw or decided.

0049 makes this more pressing. It adds three identity modes, trigger
overrides, and webhook senders resolved to delegated subjects. It records
*who launched a run, as which identity*. The obvious next question, "what did
that run actually do?", has no answer today.

Two different questions need two different stores:

| | Audit (0049) | Observability (this ADR) |
| --- | --- | --- |
| Question | who launched what, as whom, with whose credentials | what the run did: prompts, decisions, tool calls, tokens, latency, cost |
| Completeness | every launch *and every refusal*, never sampled | best effort; may sample, may drop when the backend is down |
| Written | synchronously, before the run starts | asynchronously, batched |
| Content | identifiers only, never token material | may include prompts and tool output (user data) |
| Retention / access | security record, kept | operational, shorter, wider read access |

## Decision

### 1. The audit record stays the source of truth; traces join to it

Langfuse is **not** the audit trail. The `agent-launch` log line from 0049 is
written whether or not tracing is enabled, reachable, or sampled.

The two are joined by identifiers on both sides:

- The audit record gains `traceId`, the W3C trace id of the turn.
- Every trace carries the audit identifiers as attributes. Langfuse maps some
  of them to first-class fields; verify the exact attribute names against the
  deployed Langfuse version's OpenTelemetry mapping.

| Attribute | Value | Langfuse field |
| --- | --- | --- |
| `langfuse.user.id` | `delegatedSubject` if present, else the verified sender `<provider>:<login>` (webhook), else `launchedBy` | User |
| `aktis.launched_by` | `launchedBy` (the authenticated caller, e.g. the webhook service identity) | metadata |
| `langfuse.session.id` | the turn's `sessionId` | Session |
| `aktis.agent_run` | AgentRun name | metadata |
| `aktis.agent` | Agent name | metadata |
| `aktis.identity_mode` / `aktis.identity_mode_source` | `agent\|delegated\|hybrid` / `default\|trigger\|inferred` | metadata, and tags (`identity:delegated`) |
| `aktis.entry_point` | `chat\|webhook\|cron` | metadata, and tag |
| `aktis.trigger` | EventTrigger name | metadata |
| `aktis.sender` | `<provider>:<login>` (webhook) | metadata |
| `aktis.read_only` | bool | metadata |

So "what did this person's run do?" is one lookup from the audit record to
its trace. "Show me every `delegated` run that failed this week" is a
Langfuse filter.

### 2. Instrument with OpenTelemetry; Langfuse is the first exporter

All instrumentation uses OpenTelemetry, with the GenAI semantic conventions
(`gen_ai.request.model`, `gen_ai.usage.input_tokens`, …) on model calls.
Langfuse ingests that over OTLP. Nothing in the code imports a Langfuse SDK,
so the backend can change, or a second one can be added, without
re-instrumenting.

**An in-cluster OpenTelemetry Collector sits between every emitter and
Langfuse.** The collector is the only component that holds Langfuse keys and
has egress to it.

- **Emitters stay simple.** The orchestrator, the Temporal worker, and agent
  pods only get `OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`. No
  Langfuse credentials go into an agent pod, which runs arbitrary bash.
- **Redaction is enforced in one place** (§5), in the collector's processors,
  as well as at the emitter.
- Sampling, batching and fan-out to other backends are collector config, not
  code.

### 3. What is traced

The trace tree for one turn:

```
turn                                  (Temporal ConversationWorkflow)
├─ preflight.authorize                (authz.Authorize: verdict, mode, providers resolved — names only)
├─ retrieve.skills / retrieve.agents
├─ llm.select_delegate                (generation: model, tokens, latency)
├─ llm.plan_action                    (generation)
├─ agent_run claude-code-swe-agent-7f3k2
│  ├─ tool github.create_pr           (from TurnEvents: tool-started → tool-finished|failed)
│  ├─ approval                        (approval-required → approval-resolved)
│  └─ generation …                    (§3c: from inside the pod)
└─ turn.completed
```

**a. The Temporal engine** (`orchestrator/engines/temporal`):
- Register the Temporal SDK's OpenTelemetry tracing interceptor
  (`go.temporal.io/sdk/contrib/opentelemetry`) on the client and worker
  (`cmd/worker/main.go`, `cmd/gateway/main.go`). Workflow spans come from the
  interceptor, so workflow code stays deterministic and never touches the
  tracer.
- Activities add spans directly. `llm.Client.Complete` / `CompleteJSON` /
  `Embedder.Embed` (`internal/llm`) become generation spans with model, token
  usage and latency. `authz.Authorize` records its verdict and
  `identityMode`.
- The gateway's `/invoke` starts the root span. Its context is propagated
  into the workflow by the interceptor.

**b. Sub-agent activity, with no instrumentation in the pod.** Sub-agents
already stream TurnEvents (`tool-*`, `approval-*`, `warning`, `narration`,
`turn-completed`) back to the engine
(`internal/messaging/turnevent.go`, consumed in `workflows/agentloop.go`). The
engine turns that stream into child spans under the `agent_run` span. That
gives tool-level visibility for **every** agent image immediately, with no
image changes and no telemetry egress from pods.

**c. Model calls inside the pod.** This is a later phase. The SWE agents run
the Claude Code CLI and opencode as subprocesses, so `@aktis/agent-runtime`
never sees their model calls.
- The launcher passes `TRACEPARENT` and `OTEL_EXPORTER_OTLP_ENDPOINT` into the
  AgentRun. `run_job.go` maps them like `AGENT_READ_ONLY`.
- Each image enables its CLI's own OpenTelemetry export, pointed at the
  collector. Claude Code has built-in OpenTelemetry export, enabled with
  `CLAUDE_CODE_ENABLE_TELEMETRY`. Which signals (metrics, log events, spans)
  are available, and whether opencode has an equivalent, must be checked
  against the pinned CLI versions before this phase is scoped.
- Where a CLI emits log events rather than spans, a collector pipeline turns
  them into spans under the propagated parent.
- `@aktis/agent-runtime` sets up the OpenTelemetry SDK from those env vars,
  so a non-CLI agent written against it gets generation spans for free.

### 4. Trace context crosses every hop

The context passes integration-gateway → agent-orchestrator → the Temporal
gateway `/invoke` → workflow → AgentRun → pod.

- Every HTTP hop uses the W3C `traceparent` header.
- The Temporal interceptor carries it from the gateway into the workflow.
- The AgentRun carries it as `spec.launch.traceparent` (0049's `spec.launch`)
  and the controller passes it to the pod as `TRACEPARENT`.

A webhook delivery, the turn it started, and the run that turn launched are
one trace. A refused delivery (0049's `403 identity_link_required`) is a short
trace that ends in an error span carrying the error code. That makes "how
often do senders hit the link wall?" a dashboard rather than log
archaeology.

### 5. Content capture is off by default, and the platform can only tighten it

Prompts, model output and tool output can contain private repository content,
knowledge-base documents (which ADR 0040 hydrates *per user* precisely so they
don't leak), and personal data. Sending them to a trace backend that more
people can read than the source system allows would undo 0040.

- **`metadata` (default):** spans carry structure, timing, model, token
  counts, tool ids, outcomes and error codes. No prompt or output text.
- **`content`:** also capture prompts and outputs, truncated to a size limit.
- **Precedence:**
  - The chart's global `observability.contentCapture` is the ceiling.
  - `Agent.spec.observability.capture` can opt an agent in, up to that
    ceiling.
  - A turn that touched a knowledge base, or ran in `delegated`/`hybrid`
    mode, is forced to `metadata`. Content read with a user's own
    credentials stays out of a shared backend. Same "only restricts" rule as
    `readOnly`.
- **Never captured at any level:** credential env values, `secretEnv`,
  `Authorization` headers, assertion headers, identity-link tokens. This is
  enforced twice: an allowlist of attributes at the emitter, and an
  attributes/transform processor in the collector that drops anything
  matching token patterns.

### 6. Deployment

- **The collector** ships in the agent-controller chart, off by default
  (`observability.enabled`), like the MCP broker.
- **Langfuse is self-hosted.** Trace data, including user subjects, never
  leaves infrastructure the operator controls. Langfuse Cloud is not a
  supported target.

#### Two ways to get a Langfuse, the same as Open WebUI

The agent-controller chart gets an optional `langfuse` dependency on
Langfuse's official chart (`https://langfuse.github.io/langfuse-k8s`). It is
pinned exact and off by default, wired the same way `openwebui` is: a remote
dependency with `condition: langfuse.enabled`. The collector doesn't care
which path is used; it only needs an endpoint and a key pair.

```yaml
observability:
  enabled: true                 # the collector + engine/agent OTLP env
  langfuse:
    # Bundled path (langfuse.enabled=true): leave endpoint empty and the chart
    # derives the in-release service, http://<release>-langfuse-web:3000.
    # Bring-your-own path (langfuse.enabled=false): set it to your existing
    # deployment's base URL.
    endpoint: ""
    # Project key pair used for OTLP Basic auth. Bundled: the same Secret
    # seeds the bundled Langfuse's headless init (LANGFUSE_INIT_PROJECT_*), so
    # the project and its keys exist on first boot with no UI step.
    # BYO: the keys of a project you created in your Langfuse.
    keysSecretRef: { name: langfuse-project-keys, publicKey: public-key, secretKey: secret-key }
  # Optional extra OTLP exporters (Tempo, Honeycomb, another collector...),
  # alongside or instead of Langfuse.
  extraExporters: {}

langfuse:                       # the subchart's own values, passed through
  enabled: false
```

| `observability.enabled` | `langfuse.enabled` | `observability.langfuse.endpoint` | Result |
| --- | --- | --- | --- |
| `false` | any | any | no tracing; audit unaffected |
| `true` | `true` | empty | **bundled:** export to the in-release Langfuse |
| `true` | `true` | set | bundled Langfuse is deployed, but export goes to `endpoint` (lets you migrate between instances) |
| `true` | `false` | set | **bring your own:** export to the existing deployment |
| `true` | `false` | empty | **render fails** with a `fail` message naming both options. With `extraExporters` set, Langfuse is skipped and the other exporters still work. |

**Bring your own** is a pure override: disable the subchart and set
`endpoint` + `keysSecretRef`. Nothing else in the chart references the
subchart, so a pre-existing Langfuse in another namespace, another cluster,
or behind an ingress is just a URL. It only has to be reachable from the
collector.

**The bundled path is not a toy, but its defaults are.** Langfuse (v4; chart
`langfuse-k8s` 2.2.4, pinned) needs
Postgres, ClickHouse, Redis and S3-compatible blob storage. Its chart can run
each one in-release, or point each at an external service. We don't build an
opinion on top. Our `values.yaml` shows:
- a dev profile (everything in-release; the minimum that runs);
- a production profile: in-release ClickHouse, sized explicitly. External
  Postgres and Redis. S3 from an ACK-provisioned bucket, the same pattern as
  image-gen, with IRSA on EKS rather than static keys.

Checked at pinning (chart 2.2.4): its datastores are groundhog2k Postgres,
Valkey and SeaweedFS, none of them Bitnami, so the registry and licensing
concern does not apply. ClickHouse is deployed through ClickHouse-operator
CRDs, which must already be installed (the chart refuses to render
otherwise). Offline renders pass `langfuse.clickhouse.crdCheck=false`. The
headless-init variables (`LANGFUSE_INIT_*`) are wired from the shared key
Secret but still need verifying against a running v4 instance.

**Upstream values pass through untouched** under `langfuse:`, the same as
`openwebui:`. Only three things are wired for the operator:
- the headless-init key Secret above;
- `NEXTAUTH_URL`;
- IdP sign-in, using the deployment's own OIDC IdP (the one the Connections
  page uses, ADR 0046). A bundled Langfuse is not left on local email and
  password sign-up.

**Either path:**
- **Access:** the Langfuse UI is limited to operators. Even under
  `metadata` capture, traces hold user subjects, so the project is personal
  data.
- **Retention:** set Langfuse's retention shorter than the audit log's.
  Traces are operational, and the audit record is what's kept.
- **Chart hygiene:** the `langfuse` dependency is a *remote* chart, so its
  packed `charts/langfuse-*.tgz` is expected, like `open-webui` and `nats`.
  The local-subchart tgz cleanup rule doesn't apply to it. Adding it is a
  template change, so the chart version is bumped.

- **Sampling:** 100% by default. Agent runs are few and expensive, so
  sampling buys little and loses the run you needed. Tail sampling stays
  available in collector config. The audit record is never sampled, because it
  doesn't go through this pipeline.
- **Resources:** the collector gets explicit requests and limits. Turning on
  in-pod telemetry (§3c) must be checked against agent pod headroom before it
  is enabled, because a starved subprocess fails without being OOM-killed.

## Consequences

- Every run is inspectable after its pod is gone: tool sequence, approvals,
  planner decisions, token cost per run, agent, user and identity mode.
- An audit record from 0049 links to exactly one trace, and a trace names
  the audit fields. Accountability and debugging meet without merging their
  stores.
- **Phase 1 needs no agent image changes.** Orchestrator spans plus the
  TurnEvent spans cover every agent.
- Model-level detail inside the SWE agents depends on what the CLIs export
  (§3c), and may be partial.
- Default traces carry user subjects (`openwebui:<id>`). The Langfuse project
  is therefore access-controlled personal data even with content capture off.
- New moving part: the collector. If it's down, tracing is lost and nothing
  else is. Exporters must be non-blocking with bounded queues, and an
  unreachable collector must never fail or slow a turn.

## Rollout (PR sequence)

0. **Chart: optional Langfuse subchart + bring-your-own wiring.**
   - The `langfuse` dependency (exact pin, `condition: langfuse.enabled`).
   - The `observability.langfuse.{endpoint,keysSecretRef}` override, the
     endpoint derivation and the render-time `fail`.
   - Headless-init key wiring and the dev/prod values profiles.
   - Bring up homelab on the bundled path first.
1. **Collector + engine spans.** Chart: collector Deployment and
   `observability.*` values, all off by default. Temporal: OpenTelemetry SDK
   setup, Temporal tracing interceptor, generation spans in `internal/llm`,
   pre-flight span, `traceparent` on `/invoke`. Can land before 0049.
2. **TurnEvent → spans** for sub-agent tool calls and approvals, plus
   propagation through integration-gateway and agent-orchestrator.
3. **Join with 0049.** Lands after 0049 PR 2. Add `traceId` to the
   `agent-launch` record, `traceparent` to `spec.launch`, the identity
   attributes and tags from §1, and error spans for `identity_link_required`
   / `identity_ambiguous`.
4. **Content-capture policy.** `Agent.spec.observability.capture`, the chart
   ceiling, forced `metadata` for knowledge-base and delegated turns, and the
   collector redaction processor. Required before anyone sets
   `contentCapture` above `metadata`.
5. **In-pod model telemetry** (§3c): `TRACEPARENT` / OTLP env on AgentRuns,
   CLI telemetry per image, OpenTelemetry setup in `@aktis/agent-runtime`.
   Scoped after the CLI-version check.

### Verification

- **One trace end to end.** An e2e webhook → agent run produces a single trace
  whose id matches the `agent-launch` record. The assertion must be shown to
  fail by breaking propagation at one hop.
- **No secret ever reaches the backend.** A test run with known canary
  values in `secretEnv`, identity-link tokens and assertion headers. The
  collector's output (a file exporter in e2e) is grepped for each canary.
  The test is shown to fail by deliberately allowlisting one.
- **Content capture is forced off where it must be.** A knowledge-base turn
  and a `delegated` turn with `capture: content` produce no prompt text.
- **Tracing never breaks a turn.** A turn with the collector scaled to zero
  completes with normal latency, and its audit record is still written.

## Resolved questions

1. **Self-hosted everywhere** (§6). Trace data, including user subjects, stays
   on operator-controlled infrastructure. The chart can bundle Langfuse as an
   optional subchart, like Open WebUI, or be pointed at an existing
   deployment.
2. **A webhook run's trace user is the human it acted for.** That means
   `langfuse.user.id` = `delegatedSubject` when the sender resolved to one.
   The launching service identity is kept as `aktis.launched_by` metadata. An
   `agent`-mode webhook run whose sender didn't resolve to a subject uses
   `<provider>:<login>` from the verified sender, so it is still attributed to
   a person rather than to the gateway.
