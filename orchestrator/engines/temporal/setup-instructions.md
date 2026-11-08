# Setup instructions

Everything needed to run durable-agents, from laptop-only dev to a full
k3s deployment. Three binaries make up the system:

| Binary | Role |
| ------ | ---- |
| `gateway` | OpenAI-compatible chat facade (`:8080`) + tool-callback bridge (`:8081`) |
| `worker` | Temporal worker: conversation/agent/tool workflows + all activities |
| `catalog-sync` | Watches Tool/Skill/Agent CRs → mirrors them into Qdrant |

---

## 1. Local development (no cluster at all)

Prereqs: Go 1.24+, [Temporal CLI](https://docs.temporal.io/cli), Docker
(for Qdrant), an OpenAI API key.

```bash
# 1. Infrastructure
temporal server start-dev                          # terminal 1 — :7233, UI :8233
docker run -d --rm -p 6334:6334 qdrant/qdrant      # vector store

# 2. Seed a sample catalog (recipe tools/skill, meal-planner + swe-helper agents)
export OPENAI_API_KEY=sk-...
go run ./cmd/dev-seed

# 3. Worker — fake tool mode: launches are logged, you play the tool by hand
QDRANT_HOST=127.0.0.1 \
TOOLRUN_MODE=fake \
CALLBACK_BASE_URL=http://127.0.0.1:8081 \
go run ./cmd/worker                                # terminal 2

# 4. Gateway — everyone resolves to a dev identity with the "cook" role
AGENT_CALLBACK_SECRET=$(openssl rand -hex 32) \
AGENT_DEFAULT_SUBJECT=user:dev \
AGENT_DEFAULT_ROLES=cook \
go run ./cmd/gateway                               # terminal 3
```

Chat (the `X-Session-Id` header keys the durable conversation):

```bash
curl -s localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' -H 'X-Session-Id: demo' \
  -d '{"model":"durable-agents","messages":[{"role":"user","content":"Grab https://example.com/pasta for me"}]}'
```

With `TOOLRUN_MODE=fake` the worker log prints each tool launch and its
callback URL. Play the tool by posting a signed event (use the same secret
you gave the gateway):

```bash
SECRET=<the AGENT_CALLBACK_SECRET value>
URL=<callback URL from the worker log>
JOB=<job id from the worker log>
BODY='{"job_id":"'$JOB'","seq":1,"ts":"2026-01-01T00:00:00Z","type":"succeeded","result":"# Pasta\nBoil water."}'
curl -X POST "$URL" \
  -H "x-signature: sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $NF}')" \
  -d "$BODY"
```

No OpenAI key / offline? Any OpenAI-compatible endpoint works via
`OPENAI_BASE_URL` (the smoke tests use a scripted mock serving
`/chat/completions` + `/embeddings`).

Useful while poking around:

```bash
temporal workflow list                                        # conversations, agents, tool runs
temporal workflow query -w conversation-demo --type conversation-state
temporal workflow query -w conversation-demo --type turn-progress
make build test vet                                           # checks
```

---

## 2. Deploying to k3s

### Prerequisites (installed once, in this order)

1. **agent-controller** — owns the CRDs (`Tool`/`ToolRun`/`Skill`/`Agent`),
   the Go core-controller that turns ToolRuns into hardened Jobs, and the
   tool images. Install its charts per its README (`agent-controller` chart
   first, then `community-components` for the sample catalog). Default
   namespace assumption here: `controller-agent`.
2. **Temporal** — e.g. the `temporalio/temporal` Helm chart (the
   `temporal-local` repo's helmfile does this). Note the frontend address,
   e.g. `temporal-frontend.temporal.svc:7233`.
3. **Qdrant** — any instance reachable over gRPC (port 6334). The chart
   does not bundle one.

### Secrets

```bash
NS=durable-agents           # release namespace
CATALOG_NS=controller-agent # where agent-controller keeps CRs / runs Jobs
kubectl create namespace $NS

# LLM + embeddings key (worker + catalog-sync)
kubectl -n $NS create secret generic durable-agents-secrets \
  --from-literal=OPENAI_API_KEY=<key>

# Callback HMAC — SAME value in BOTH namespaces:
# gateway verifies with it; the controller injects it into tool Jobs to sign.
SECRET=$(openssl rand -hex 32)
kubectl -n $NS create secret generic durable-agents-callback \
  --from-literal=AGENT_CALLBACK_SECRET="$SECRET"
kubectl -n $CATALOG_NS create secret generic durable-agents-callback \
  --from-literal=AGENT_CALLBACK_SECRET="$SECRET"
```

### Images

```bash
make docker   # durable-agents-{gateway,worker,catalog-sync}:latest
```

Get them where k3s can pull them — either your registry (retag + push) or
direct import on the node(s):

```bash
docker save durable-agents-gateway durable-agents-worker durable-agents-catalog-sync \
  | ssh <node> 'sudo k3s ctr images import -'
```

### Install

```bash
helm install durable-agents charts/durable-agents -n durable-agents \
  --set temporal.address=temporal-frontend.temporal.svc:7233 \
  --set qdrant.host=<qdrant-host> \
  --set catalog.namespace=controller-agent
```

What the chart creates: gateway + worker + catalog-sync Deployments; a
ClusterIP service for chat (`<release>-gateway:8080`) and a cluster-internal
one for callbacks (`<release>-gateway-callback:8081`); ServiceAccounts with
namespaced Roles in `catalog.namespace` (catalog-sync: read
tools/skills/agents; worker: create/get toolruns). Nothing needs
cluster-wide RBAC and nothing touches `batch/jobs` — the core-controller
alone creates Jobs.

### Identity (dev-grade)

The gateway maps bearer tokens via `STATIC_IDENTITIES` env (JSON:
`{"token": {"subject": "user:x", "roles": ["cook"]}}`), with
`AGENT_DEFAULT_SUBJECT`/`AGENT_DEFAULT_ROLES` as the fallback for tokenless
callers. Unresolved callers fail closed to zero capabilities. Set these via
extra env on the gateway Deployment (values knob TBD — milestone 8). OIDC
is not ported yet.

### Point a chat client at it

Any OpenAI-compatible client works against
`http://<release>-gateway.durable-agents.svc:8080/v1`. For Open WebUI, set
`ENABLE_FORWARD_USER_INFO_HEADERS=true` so its chat id header gives you
durable per-conversation sessions; otherwise send `X-Session-Id` yourself.

### Smoke checks

```bash
kubectl -n durable-agents logs deploy/durable-agents-catalog-sync | tail   # "indexed <cr>" lines
temporal workflow list                                                     # after a first chat turn
kubectl -n controller-agent get toolruns                                   # after a turn that used a tool
```

---

## 3. Current limitations (pre-milestone-8)

- **Prompts are untuned against real models** — everything ran against a
  scripted mock until now; expect iteration on selection/planning quality.
- **Large tool results**: callback events are capped at 1MiB (413 above);
  artifact-ref handling for big payloads is milestone 8.
- **Pod agents need a conforming step image** — the contract is
  [docs/pod-agents.md](docs/pod-agents.md); the opencode adapter (and a
  `ToolRunSpec.secretEnv` upstream addition for per-user tokens) hasn't
  been built. Declarative agents and all tools work today.
- **Identity** is the static resolver only; per-user provider credentials
  use the env-based `IDENTITY_LINKS` store on the worker.
- **Observability** is logs + the Temporal UI; metrics/tracing land in
  milestone 8.
