# Standing up on bitovi-platform-services

The platform (`~/developer/bitovi-platform-services`) already runs
everything durable-agents depends on, all ArgoCD-managed:

| Dependency | Where it already is |
| ---------- | ------------------- |
| agent-controller (CRDs, core-controller, tool images) | `gitops/apps/agent-controller.yaml`, ns `agent-controller`, wave 40 |
| Catalog CRs (recipe-scraper Tool, recipe skill, opencode Agent) | `gitops/apps/agent-catalog.yaml`, wave 42; roles are `reader`/`writer` |
| Temporal (+ CNPG Postgres, `default` ns registered) | `gitops/apps/temporal.yaml`, `temporal-frontend.temporal.svc:7233`, wave 30 |
| Qdrant | `gitops/apps/agent-deps.yaml` → service `agent-qdrant`, wave 41 |
| Secrets machinery | 1Password Connect operator; `agent-orchestrator-secrets` already holds `OPENAI_API_KEY` in ns `agent-controller` |
| Chat front-end | Open WebUI (cluster-internal), bearer `bitovi-openwebui-internal`, forwards chat-id headers |

durable-agents deploys **beside** the upstream agent-orchestrator, not
instead of it — same namespace, same controller, same catalog:

- **Qdrant collections are prefixed `da-`** (`qdrant.collectionPrefix`).
  The upstream orchestrator owns `tools`/`skills`/`agents` with a different
  payload schema; sharing collections would corrupt retrieval for both.
- **ToolRuns coexist**: upstream creates NATS-mode ToolRuns, ours are
  HTTP-callback-mode — the core-controller supports both per-CR.
- Same identity token/roles as Open WebUI already uses, so the same chat
  UI can drive either backend.

## Steps

Everything below is your call to run — cluster + work-repo changes.

### 1. ECR repos + images (manual for the first stand-up)

The platform's pipeline builds agent-controller's images because that
source is public; durable-agents is private/local, so build and push from
your machine (needs platform-account AWS credentials):

```bash
cd ~/personal/durable-agents
make ecr-push        # login, create repos if missing, build linux/amd64, push
                     # prints the tag to set in gitops/durable-agents/values.yaml
```

Tag = 12-char git SHA, matching the platform's version.yaml convention.
Images are `--platform linux/amd64` for the EKS nodes; pulls use the node
IAM role (same account), so no imagePullSecrets.

(Longer-term options if this graduates from testing: make durable-agents a
private GitHub repo with its own OIDC push role via platform-app-resources,
or move the ECR repos under the platform's Crossplane management to avoid
IaC drift from the manually-created repos.)

### 2. 1Password item

Create item `durable-agents-callback` in the `bitovi-platform` vault with a
single field named `AGENT_CALLBACK_SECRET` (value: `openssl rand -hex 32`).
The chart's `onePasswordItems` entry syncs it into the namespace; both the
gateway and the tool Jobs' `secretRef` read this one Secret (everything is
in `agent-controller`, so no dual-namespace copy needed here).

### 3. Vendor + wire into the platform repo (a PR to bitovi-platform-services)

1. Copy `charts/durable-agents/` from this repo into
   `bitovi-platform-services/charts/durable-agents/`.
2. Copy `docs/platform/durable-agents-values.yaml` to
   `gitops/durable-agents/values.yaml`, setting the three `image.tag`
   values to the tag you pushed.
3. Copy `docs/platform/durable-agents-app.yaml` to
   `gitops/apps/durable-agents.yaml`.
4. PR → merge → ArgoCD auto-syncs (wave 43). Remember: merging to main
   **deploys** — Argo has automated sync + selfHeal.

### 4. Verify

```bash
kubectl -n agent-controller logs deploy/durable-agents-catalog-sync | tail
#   → "indexed recipe-scraper", "indexed recipe-extraction", …
kubectl -n agent-controller port-forward svc/durable-agents-gateway 8080:8080 &
curl -s localhost:8080/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer bitovi-openwebui-internal' \
  -H 'X-Session-Id: shakedown-1' \
  -d '{"model":"durable-agents","messages":[{"role":"user","content":"Grab the recipe at <some-recipe-url> for me"}]}'
kubectl -n agent-controller get toolruns          # the real recipe-scraper Job
kubectl -n temporal port-forward svc/temporal-web 8081:8080   # watch workflows
```

### 5. Point Open WebUI at it (optional, after the curl shakedown)

Open WebUI supports multiple OpenAI endpoints — add ours alongside the
upstream orchestrator in `gitops/apps/agent-orchestrator.yaml`:

```yaml
extraEnvVars:
  - name: ENABLE_FORWARD_USER_INFO_HEADERS
    value: "true"
  - name: OPENAI_API_BASE_URLS
    value: "http://agent-orchestrator:8081/v1;http://durable-agents-gateway:8080/v1"
  - name: OPENAI_API_KEYS
    value: "bitovi-openwebui-internal;bitovi-openwebui-internal"
```

Both backends then appear as models in the picker (`agent-orchestrator`
vs `durable-agents`) — a live side-by-side of the two architectures.

## Platform-specific gotchas

- **Do not share Qdrant collections** (see above) — keep
  `collectionPrefix: "da-"`.
- The gateway must stay **cluster-internal** (no ingress): the static
  identity resolver is dev-grade, same posture as the upstream orchestrator
  and the Temporal UI.
- `agent-catalog`'s Agent CR (opencode) is role `writer`, `tier:
  privileged`, and speaks the **NATS agent-runtime protocol** — durable-
  agents can't delegate to it until the checkpoint-resume adapter exists
  (docs/pod-agents.md). Skill/tool turns (recipe-scraper) work end to end
  today. Declarative agents need an Agent CR with no image expectations —
  seed one via a new CR in agent-catalog when ready.
- Temporal namespace retention on the platform is **1 day** — fine for
  shakedown; long-lived HITL episodes (24h idle window) sit right at that
  edge. Bump retention if agent episodes should survive longer.
