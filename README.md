# durable-agents

> Setup: [setup-instructions.md](setup-instructions.md) — local dev with
> zero cluster, and the full k3s deployment checklist.

AI agents as **Temporal workflows** that can spin up other Temporal-workflow
agents — the successor to
[agent-controller](https://github.com/imaustink/agent-controller)'s
pod-based agent loop. Tools stay as one-shot Kubernetes Jobs (launched via
agent-controller's `ToolRun` CRs), and skill/tool selection stays RAG-based
over Qdrant. See
[docs/adr/0001](docs/adr/0001-agents-as-temporal-workflows.md) for the full
design and milestone plan.

## Components

| Path | What it is |
| ---- | ---------- |
| `cmd/gateway` | Stateless HTTP front door: OpenAI Chat Completions-compatible facade and the `/invoke` accept/poll pair, both → per-session conversation workflow via update-with-start. Also hosts the HMAC callback→signal bridge for tool Jobs, and watches `IntegrationRoute` CRs for deterministic event dispatch. |
| `cmd/worker` | Temporal worker hosting workflows and activities. |
| `cmd/catalog-sync` | Watches agent-controller's Tool/Skill/Agent CRs (dynamic informers) and mirrors them into Qdrant with derived skill access roles. |
| `internal/catalog` | CR decoding, skill-access derivation (ADR 0011 port), indexer. |
| `internal/vectorstore` | Store port + Qdrant adapter; RBAC filters baked into every read. |
| `internal/messaging` | Go port of the tool event stream + HMAC callback contract — tool containers are unchanged. |
| `internal/toolrun` | ToolRun CR launcher (k8s dynamic client) + fake mode for cluster-less dev. |
| `internal/temporal` | Shared Temporal client/config for gateway + worker. |
| `internal/temporal/workflows` | Deterministic workflow code only: `ConversationWorkflow` plus three agent execution styles (declarative, checkpoint-resume, and NATS-bridged upstream pod agents). |
| `internal/agentrun` | Launches upstream `AgentRun` CRs and bridges their bidirectional NATS protocol into workflow signals, so `claude-code-swe-agent` and `opencode-swe-agent` run unmodified. See [docs/pod-agents.md](docs/pod-agents.md). |
| `internal/authz` | The authorization pre-flight: one owner, plain control flow, credentials written to a Secret so a value never enters workflow state. |
| `internal/identitylink` | Client for agent-controller's integration-gateway credential API. |
| `internal/callertools` | Consumer-supplied tools over the OpenAI facade (upstream ADR 0035). |
| `internal/temporal/activities` | All non-deterministic work (LLM calls; later: Qdrant, ToolRun CRs, identity). |
| `internal/llm` | Minimal OpenAI-compatible chat client (base URL overridable). |
| `charts/durable-agents` | Helm chart: gateway + worker. Assumes Temporal is already installed. |

## How a turn flows

1. `POST /v1/chat/completions` (optionally with `X-OpenWebUI-Chat-Id` or
   `X-Session-Id` for conversation continuity; bearer token resolved to a
   subject + roles, fail closed).
2. The gateway does **update-with-start** on `conversation-<session-id>`:
   starts the workflow if absent, then sends the turn as a `user-turn`
   Update.
3. The workflow runs the ported agent loop, every LLM/RAG/k8s call an
   activity: active-skill fit check (skips retrieval on a hit) → capability
   gate (conversational turns answer directly) → RBAC-filtered skill
   retrieval from Qdrant → skill selection → resolve the skill's declared
   tools → plan ⇄ runTool loop (max 4 steps; tool ids re-validated; ToolRun
   CR + durable signal wait per call) → compose the reply around the
   verbatim tool result.
4. The workflow idles under a 30-minute timer (then completes) and
   continues-as-new after 40 turns to bound event history.

No session store, no Redis, no in-memory pending state — the workflow *is*
the session, including the active skill and continuation tokens.

## Caller-supplied tools

Any OpenAI-compatible client can offer its own functions in the request body
and have them selected alongside the in-cluster catalog (upstream ADR 0035).
The client executes them; this system only decides one fits, returns
`finish_reason: "tool_calls"`, and picks the conversation back up when the
client resends with `role: "tool"` results.

Costs nothing when unused: definitions are keyed by content hash, so identical
tools embed once ever, and a caller sending at most `AGENT_CALLER_TOOL_TOP_K`
(default 5) tools never touches the store at all. Their own `caller_tools`
collection, never the catalog's — one caller's ephemeral definitions must not
enter another's candidate set. A skill can refuse them with
`allowCallerTools: false`.

## Event-driven turns (`/invoke`)

An adapter (agent-controller's integration-gateway) posts
`{request, sessionId, event}` and polls:

```bash
curl -s -XPOST localhost:8080/invoke -H 'Content-Type: application/json' -d '{
  "request": "an issue was labeled",
  "sessionId": "github:acme/widgets#7",
  "event": {"source":"github","event":"issues","action":"labeled",
            "labelName":"ai-triage","owner":"acme","repo":"widgets",
            "issueNumber":7,"title":"Crash on save"}
}'
# {"id":"conversation-github-acme-widgets-7.<uuid>","status":"pending"}

curl -s localhost:8080/invoke/<id>
# {"id":"...","status":"succeeded","result":"..."}
```

When the `event` matches an `IntegrationRoute` CR, its `promptTemplate` is
rendered and the named Skill/Agent is dispatched directly — no RAG retrieval
(upstream ADR 0024). No match behaves exactly as before the field existed.

The invocation id names a workflow update, so a poll is answered from
Temporal rather than from process memory: any replica can serve it, and a
gateway that dies mid-turn costs the caller nothing. This is upstream's
ADR 0006 restart/scale-out gap, and the "durable invocation records, which
this does not attempt" that ADR 0033 closes on.

`event.senderLogin` says which human triggered the turn, and therefore which
stored credentials the run may receive. Set
`GATEWAY_SENDER_ASSERTION_SECRET` on both this gateway and
integration-gateway to require it signed (`x-gateway-user-assertion`,
wire-compatible with upstream); unset, the unsigned body field is trusted and
both processes warn at startup.

For cluster-less development: `go run ./cmd/dev-seed` populates Qdrant with
a sample catalog, `TOOLRUN_MODE=fake` logs tool launches instead of creating
ToolRun CRs, and you play the tool by posting HMAC-signed events to the
callback listener.

## Local development

Prereqs: Go 1.24+, [Temporal CLI](https://docs.temporal.io/cli), an OpenAI
API key (or any OpenAI-compatible endpoint via `OPENAI_BASE_URL`).

```bash
temporal server start-dev          # terminal 1 — Temporal at localhost:7233

export OPENAI_API_KEY=sk-...
go run ./cmd/worker                # terminal 2

go run ./cmd/gateway               # terminal 3 — listens on :8080

# terminal 4 — two turns in one durable conversation
curl -s localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'X-Session-Id: demo' \
  -d '{"model":"durable-agents","messages":[{"role":"user","content":"Remember the number 41."}]}'
curl -s localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'X-Session-Id: demo' \
  -d '{"model":"durable-agents","messages":[{"role":"user","content":"What number did I ask you to remember?"}]}'
```

Inspect the conversation in the Temporal UI (http://localhost:8233):
workflow id `conversation-demo`, query `conversation-state`.

```bash
make build test vet   # checks
make docker           # build both images
```

## Deploying (k3s)

Assumes a Temporal cluster (e.g. the `temporalio/temporal` chart) is
installed and reachable at `temporal.address`.

```bash
kubectl create namespace durable-agents
kubectl -n durable-agents create secret generic durable-agents-secrets \
  --from-literal=OPENAI_API_KEY=<key>

helm install durable-agents charts/durable-agents -n durable-agents \
  --set temporal.address=temporal-frontend.temporal.svc:7233
```

Point an OpenAI-compatible client (e.g. Open WebUI, with
`ENABLE_FORWARD_USER_INFO_HEADERS=true` for session continuity) at the
gateway service.

## Roadmap

Milestone plan lives in
[docs/adr/0001](docs/adr/0001-agents-as-temporal-workflows.md#milestones):
catalog/RAG activities → ToolRun execution with callback→signal bridge →
full agent-loop parity → child-workflow sub-agents with HITL signals →
checkpoint-resume pod agents.
