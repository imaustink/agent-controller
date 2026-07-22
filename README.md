# durable-agents

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
| `cmd/gateway` | Stateless HTTP front door: OpenAI Chat Completions-compatible facade → per-session conversation workflow via update-with-start. Later also hosts the HMAC callback→signal bridge for tool Jobs. |
| `cmd/worker` | Temporal worker hosting workflows and activities. |
| `cmd/catalog-sync` | Watches agent-controller's Tool/Skill/Agent CRs (dynamic informers) and mirrors them into Qdrant with derived skill access roles. |
| `internal/catalog` | CR decoding, skill-access derivation (ADR 0011 port), indexer. |
| `internal/vectorstore` | Store port + Qdrant adapter; RBAC filters baked into every read. |
| `internal/messaging` | Go port of the tool event stream + HMAC callback contract — tool containers are unchanged. |
| `internal/toolrun` | ToolRun CR launcher (k8s dynamic client) + fake mode for cluster-less dev. |
| `internal/temporal` | Shared Temporal client/config for gateway + worker. |
| `internal/temporal/workflows` | Deterministic workflow code only (`ConversationWorkflow`). |
| `internal/temporal/activities` | All non-deterministic work (LLM calls; later: Qdrant, ToolRun CRs, identity). |
| `internal/llm` | Minimal OpenAI-compatible chat client (base URL overridable). |
| `charts/durable-agents` | Helm chart: gateway + worker. Assumes Temporal is already installed. |

## How a turn flows

1. `POST /v1/chat/completions` (optionally with `X-OpenWebUI-Chat-Id` or
   `X-Session-Id` for conversation continuity).
2. The gateway does **update-with-start** on `conversation-<session-id>`:
   starts the workflow if absent, then sends the turn as a `user-turn`
   Update.
3. The workflow appends the message to its durable history, runs the
   `CompleteTurn` LLM activity, and returns the reply as the Update result.
4. The workflow idles under a 30-minute timer (then completes) and
   continues-as-new after 40 turns to bound event history.

No session store, no Redis, no in-memory pending state — the workflow *is*
the session.

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
