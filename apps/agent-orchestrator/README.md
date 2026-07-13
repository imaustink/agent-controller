# agent-orchestrator

The parent orchestrator: resolves a caller's request into a k8s Job launch,
using RAG to pick the right tool/sub-agent out of a static, build-time,
RBAC-scoped catalog. Design rationale lives in
[../../docs/orchestrator.md](../../docs/orchestrator.md) and
[../../docs/adr/](../../docs/adr/) — read those first; this README is the
tool-specific build/run/config reference.

**Status:** first implementation pass. Wiring, ports, and unit tests are in
place; several pieces noted below are intentionally minimal stand-ins for
things called out as open questions in the design doc.

## What it does

1. Accepts a request over HTTP: `POST /invoke` with a caller
   `Authorization: Bearer <token>` and `{ "request": "..." }` body. Returns
   `202 { id, status: "pending" }` immediately (see ADR 0006 for why this is
   asynchronous rather than a blocking call).
2. Resolves that token into an `Identity` (roles/scopes).
3. If the caller's conversation already has an **active skill** (ADR 0012 —
   keyed by Open WebUI's chat-id header or `/invoke`'s optional
   `session_id`), re-fetches it under the caller's current roles and runs a
   cheap fit-check ("does this turn still belong to that skill?"). On a fit,
   retrieval + selection below are skipped entirely; on any miss it falls
   through to the full path — a miss is never an error.
4. Queries the RAG **skill** index (Qdrant), filtered to skills whose
   *derived* audience includes that identity — a skill carries no roles of
   its own; its audience is the intersection of its tools' `allowedRoles`,
   computed at startup (ADR 0011). An unresolved identity always yields
   zero candidates (ADR 0008).
5. Asks an LLM (Structured Outputs, no tool-calling ability) to pick one
   candidate skill for the request, then resolves that skill's declared tool
   ids directly (`VectorStore.getByIds`, RBAC re-checked as a
   defense-in-depth backstop).
6. Asks another LLM call (system prompt = the selected skill's `markdown`) to
   decide whether to respond directly (no tool call) or call one of that
   skill's tools.
7. If a tool was chosen, launches it as a Kubernetes Job with the same
   hardened container contract as `recipe-scraper` (dropped capabilities,
   read-only root fs, non-root, no privilege escalation).
8. Waits for the Job's result via the existing
   [`@controller-agent/messaging`](../../packages/messaging/) callback protocol,
   then makes it available via `GET /invoke/:id`.

Sub-agents are launched exactly the same way as tools (same code path), just
targeting the orchestrator's own image with a narrower task — see
[docs/orchestrator.md](../../docs/orchestrator.md#5-sub-agents).

## Layout

```
src/
├── index.ts                      # long-lived service entry: starts both HTTP listeners
├── server.ts                      # InvokeServer: POST /invoke + GET /invoke/:id (ADR 0006), plus /v1/models + /v1/chat/completions (ADR 0007)
├── openai/                       # OpenAI Chat Completions wire-format translation (ADR 0007)
│   ├── chat-completions.ts       # request/response/SSE shape builders, error mapping
│   └── with-heartbeat.ts         # SSE keep-alive while a graph step is slow
├── config.ts                     # env-driven configuration
├── tool-descriptor.ts            # ToolDescriptor / JobTemplate shared types
├── vector-store/                 # RAG: VectorStore port + Qdrant adapter (ADR 0003)
│   ├── types.ts
│   ├── qdrant-store.ts           # tool index; also exposes getByIds() for skill-scoped lookup (ADR 0008)
│   └── openai-embedder.ts
├── skills/                       # Skill layer: Skill CRDs + Qdrant collection (ADR 0008, 0010)
│   ├── types.ts                  # SkillDescriptor / SkillAccess / SkillStore port
│   ├── derive-access.ts          # skill audience = ∩ of its tools' allowedRoles (ADR 0011)
│   ├── crd-skill-registry.ts     # reads Skill custom resources (ADR 0010)
│   └── qdrant-skill-store.ts
├── registry/                     # Tool catalog discovered from CRDs (ADR 0010)
│   ├── types.ts
│   ├── crd-tool-registry.ts      # reads Tool custom resources (the wired default, ADR 0010)
│   └── crd-local-tool-registry.ts # reads LocalTool custom resources (ADR 0014)
├── rbac/                         # Identity resolution (ADR 0004)
│   ├── types.ts
│   └── static-identity-resolver.ts  # DEV/TEST ONLY — see file header
├── session/                      # Conversation-session store (ADR 0012)
│   ├── types.ts                  # SessionStore port + SessionRecord
│   └── in-memory-session-store.ts # sliding-TTL Map; single-replica only
├── k8s/
│   ├── container-tool-launcher.ts # ContainerToolLauncher port (launch a container tool, ADR 0010)
│   └── toolrun-launcher.ts       # creates a ToolRun CR; the Go controller reconciles the Job (ADR 0010)
├── callback/
│   └── receiver.ts                # HTTP receiver for Job -> orchestrator results
└── agent/
    ├── graph.ts                  # LangGraph.js agent loop (ADR 0002, restructured for skills in ADR 0008)
    ├── skill-selector.ts         # LLM skill selection (Structured Outputs, ADR 0008)
    ├── skill-fit-checker.ts      # per-turn active-skill fit-check (Structured Outputs, ADR 0012)
    ├── action-planner.ts         # skill markdown -> system prompt; decides respond vs. call_tool (ADR 0008)
    └── response-composer.ts      # post-tool narration around the verbatim result (ADR 0015)
```

## Registering a tool

Tools are **`Tool` custom resources** discovered from the cluster (ADR 0010),
not baked into this image. `CrdToolRegistry` lists every `Tool` CR once at
startup and upserts it into the RAG index; the Go tool-controller
(`controllers/tool-controller/`) reconciles each invocation's `ToolRun` CR into
a hardened one-shot Job — the orchestrator itself never creates a Job. To
register a container tool:

1. Add `tools/<name>/tool.yaml` — a `Tool` CR with its
   description/input/output/allowedRoles/tier plus the launch metadata
   (image, serviceAccountName, env/secretEnv, resources). See
   [tools/recipe-scraper/tool.yaml](../../tools/recipe-scraper/tool.yaml).
2. `kubectl apply` it into the orchestrator's namespace, then restart the
   orchestrator so it re-reads the catalog (one-shot-at-startup, no watch loop
   yet — ADR 0010).

The target namespace's `serviceAccountName` (e.g. `recipe-scraper`) still
needs to actually exist in the cluster — this app doesn't create tool
ServiceAccounts, only its own (see the Helm chart).

## Registering a LocalTool (ADR 0014)

A `LocalTool` runs **in-pod** by a per-language executor sidecar instead of as a
Job — lower latency, code pulled from a registry and sandboxed with bubblewrap.
Apply a `LocalTool` CR (see the CRD in `controllers/tool-controller` and the
reference tools under `tools-local/`):

```yaml
apiVersion: core.controller-agent.dev/v1alpha1
kind: LocalTool
metadata: { name: http-get-node }
spec:
  description: "HTTP GET a URL and return status + body."
  input: "A URL on stdin."
  output: "An envelope { status, body }."
  allowedRoles: ["reader"]
  runtime: node
  package: "@controller-agent/http-get"
  version: "0.1.0"     # exact pin required
  network: true         # opt in to egress (default deny)
```

Enable the executor sidecars via the chart's
`agent-orchestrator.localTool.enabled` value and list the runtimes you use. The
orchestrator discovers `LocalTool` CRs at startup and indexes them into the same
RAG catalog as container tools, so a skill's `toolRefs` can name either kind.

## Calling it

```bash
# Kick off a request (auth token is per-request, not per-process)
curl -s -X POST http://localhost:8081/invoke \
  -H 'authorization: Bearer dev-token' \
  -H 'content-type: application/json' \
  -d '{"request": "scrape https://example.com/some-recipe"}'
# => 202 {"id":"<uuid>","status":"pending"}

# Poll for the result
curl -s http://localhost:8081/invoke/<uuid>
# => 200 {"id":"<uuid>","status":"succeeded","result":{...}}
```

See [ADR 0006](../../docs/adr/0006-async-http-invoke-interface.md) for why
this is async-poll rather than a blocking request/response, and why it runs
on a separate port from the Job-callback receiver.

### OpenAI-compatible chat interface

The same agent is also reachable as if it were an OpenAI chat model (ADR 0007)
— point any OpenAI-API-compatible chat UI (e.g. Open WebUI) at this service's
base URL and it will discover one model, `agent-orchestrator`:

```bash
curl -s http://localhost:8081/v1/models

# Non-streaming
curl -s -X POST http://localhost:8081/v1/chat/completions \
  -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"model": "agent-orchestrator", "messages": [{"role": "user", "content": "scrape https://example.com/some-recipe"}]}'

# Streaming (SSE) — recommended; narrates agent progress as chat deltas
curl -N -s -X POST http://localhost:8081/v1/chat/completions \
  -H 'authorization: Bearer dev-token' -H 'content-type: application/json' \
  -d '{"model": "agent-orchestrator", "stream": true, "messages": [{"role": "user", "content": "scrape https://example.com/some-recipe"}]}'
```

See [ADR 0007](../../docs/adr/0007-openai-compatible-chat-facade.md) for the
design tradeoffs (why streaming is recommended over blocking, why there's no
multi-turn memory yet, how errors are reported differently in each mode).

When the client sends a stable conversation id — Open WebUI forwards one as
an `X-OpenWebUI-Chat-Id` header when its deployment sets
`ENABLE_FORWARD_USER_INFO_HEADERS=true` (the bundled chart does) — the
conversation keeps a session-scoped **active skill** across turns (ADR 0012):
follow-up messages run a cheap fit-check against it instead of full RAG
re-selection, and the streamed narration says `Continuing with skill: …`
instead of `Selected skill: …`. `/invoke` callers can opt in by passing an
optional `"session_id"` field in the body. No conversation id → fully
stateless per-turn selection, exactly as before. Independently of the
session, a bounded window of the prior conversation (both `user` and
`assistant` turns) is folded into each request as a `<conversation_history>`
block, so in-progress artifacts — whether tool-extracted or pasted by the
user — stay visible to the planner across turns.

## Configuration

See [.env.example](.env.example) for the full list. Required: `OPENAI_API_KEY`,
`AGENT_CALLBACK_SECRET` (no default — must not be guessable, since it
authenticates Job → orchestrator callbacks).

## Known gaps (by design, not yet implemented)

These are called out explicitly rather than silently glossed over — see
[docs/orchestrator.md#open-questions-explicitly-deferred](../../docs/orchestrator.md#open-questions-explicitly-deferred):

- **Identity resolution** ships only a `StaticIdentityResolver` (a hardcoded
  dev/test token map). Real OIDC/JWT verification is not implemented — do not
  run this outside local development as-is.
- **Manifest staleness** (ADR 0009): the tool catalog only reflects what was
  baked into the orchestrator image at build time — there's no live drift
  detection between a manifest and whether that tool's image/ServiceAccount
  actually still exist/are compatible, and no refresh until the process is
  restarted with a rebuilt image.
- **Invocation state is in-memory only** (`InvokeServer`) — restarting the
  process loses in-flight/completed invocation records; there's no
  persistence or multi-replica coordination yet. The ADR 0012
  conversation-session store shares the same limitation (deliberately — a
  lost session harmlessly degrades to per-turn skill re-selection); a shared
  store behind the same `SessionStore` port is the follow-up if this ever
  runs with more than one replica.
- **No multi-turn conversation memory.** The OpenAI-compatible chat endpoint
  (ADR 0007) folds a bounded window of the prior conversation (last few
  `user`/`assistant` turns, char-capped, oldest dropped first) into the
  single request string as a `<conversation_history>` block — each call is
  still one independent agent-graph run, same as `/invoke`. ADR 0012 adds
  continuity for **skill routing only** (which skill the conversation is
  in); there is no server-side conversation store — anything that falls out
  of the bounded window (or that the chat client doesn't resend) is gone.
- **Single skill per turn.** The skill selector (ADR 0008) picks exactly one
  skill per request; merging multiple matched skills' markdown/tool lists
  isn't implemented. A conversation that pivots switches its one active
  skill (ADR 0012), never accumulates several.
- **Streamed progress narrates agent graph steps, not tool-internal stages.**
  `POST /v1/chat/completions` with `stream: true` narrates
  resolveIdentity/checkActiveSkill/retrieveSkills/selectSkill/loadSkillTools/planAction/runTool/composeResponse
  transitions, not a launched tool's own internal stages (e.g.
  recipe-scraper's extract/transcribe) — those aren't observable outside the
  Job callback protocol today.
- **Job launch RBAC is not yet scoped per-tool** — every launched Job uses the
  `serviceAccountName` named in that tool's `Tool` CR (ADR 0010); that
  ServiceAccount must already exist in the target namespace (this app doesn't
  create tool ServiceAccounts, only its own — see
  [charts/recipe-agent/charts/agent-orchestrator](../../charts/recipe-agent/charts/agent-orchestrator/) for the
  orchestrator's own ServiceAccount/Role/RoleBinding).

## Commands

- Build: `npm run build` (run from repo root first: `npm run build --workspace=@controller-agent/messaging`)
- Typecheck: `npm run typecheck` | Test: `npm test` (vitest)
- Docker build (from repo root): `docker build -f apps/agent-orchestrator/Dockerfile -t agent-orchestrator:latest .`
- Hardened run: `OPENAI_API_KEY=... AGENT_CALLBACK_SECRET=... ./run.sh` (starts the service; see [Calling it](#calling-it) above)

## Exit codes (index.ts)

This is a long-lived service — a non-zero exit now only signals a **startup**
failure (e.g. missing `AGENT_CALLBACK_SECRET`), not a per-request outcome.
Per-request failures are reported via `GET /invoke/:id` (`status: "failed"`,
`error` message), not the process exit code.
