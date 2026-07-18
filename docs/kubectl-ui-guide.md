# Operating the chat UI with `kubectl`

A practical, command-line-only guide to standing up, reaching, and
troubleshooting the **Open WebUI** chat frontend (the "ui") and the
`core-controller` custom resources ([ToolRun](#6-inspecting-toolrun--agentrun-activity), [AgentRun](#6-inspecting-toolrun--agentrun-activity)) it drives, using only
`kubectl` (no port-forward-and-hope guessing). See [orchestrator.md](orchestrator.md#7-openai-chat-completions-compatible-facade)
for why Open WebUI can talk to the agent at all (the OpenAI Chat
Completions-compatible facade), and [charts/agent-controller/README.md](../charts/agent-controller/README.md)
for the Helm chart that installs everything referenced below.

> This document assumes the `agent-controller` Helm release (and, for a
> working chat, the `openwebui` subchart) is already installed — see
> [charts/agent-controller/README.md](../charts/agent-controller/README.md)
> for install/upgrade commands. Everything here is the **day-2, `kubectl`-only**
> half: reaching the UI, verifying it's healthy, and reading what it's doing
> to the cluster.

## 1. Prerequisites

- `kubectl` pointed at the target cluster/context.
- The namespace the release was installed into (`controller-agent` in the
  documented minikube demo — substitute your own).
- The `openwebui` subchart enabled (`openwebui.enabled: true` in your values
  file — see [values.yaml](../charts/agent-controller/values.yaml)). If it's
  off, there is no UI Pod/Service to reach; everything below still applies to
  the ToolRun/AgentRun/Tool/Skill/Agent resources via the plain `/invoke` API.

Confirm the namespace and release exist:

```sh
kubectl get namespace controller-agent
helm list -n controller-agent
```

## 2. Confirm the UI is actually running

The upstream `open-webui` chart labels every resource with
`app.kubernetes.io/name=open-webui` regardless of the release/alias name, so
this selector is stable across install names:

```sh
kubectl -n controller-agent get pods -l app.kubernetes.io/name=open-webui
kubectl -n controller-agent get deploy,svc -l app.kubernetes.io/name=open-webui
```

The exact Deployment/Service *name* is derived from the Helm release name
(e.g. `agent-controller-open-webui`) and can vary depending on how the chart
was installed — don't hardcode it, grab it dynamically instead:

```sh
kubectl -n controller-agent get svc -l app.kubernetes.io/name=open-webui -o name
```

If the Pod isn't `Running`/`Ready`, check events and logs before going
further:

```sh
kubectl -n controller-agent describe pod -l app.kubernetes.io/name=open-webui
kubectl -n controller-agent logs -l app.kubernetes.io/name=open-webui --tail=100
```

A common failure mode is an `OOMKilled` (exit 137) container — Open WebUI
loads a local embedding model at startup even though this deployment doesn't
use its built-in RAG. `values.yaml` sets a 2Gi/3Gi request/limit for exactly
this reason; raise it if you still see OOM kills.

## 3. Reach the UI

No Ingress is assumed, so the standard path is a port-forward, targeting
whichever Service name step 2 resolved to:

```sh
kubectl -n controller-agent port-forward svc/$(kubectl -n controller-agent get svc -l app.kubernetes.io/name=open-webui -o jsonpath='{.items[0].metadata.name}') 8080:80
```

Then open <http://localhost:8080>. (`helm install`/`upgrade` also prints a
port-forward one-liner in the chart's `NOTES.txt` — worth diffing against the
above if it looks stale after a chart upgrade.)

## 4. Auth: why a fresh login might get a 401

Open WebUI sends its configured `openaiApiKey` as a plain
`Authorization: Bearer <key>` header on every request to the orchestrator's
OpenAI-compatible facade. In this stack that token is checked by the
orchestrator's **`StaticIdentityResolver`** — a dev/test-only stub, **not**
for production use — which only accepts tokens present in
`agent-orchestrator.config.staticIdentities`. If `openwebui.openaiApiKey` and
that map disagree (or the map is empty), every chat request 401s.

Check what the orchestrator will actually accept:

```sh
kubectl -n controller-agent get deploy agent-orchestrator -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="STATIC_IDENTITIES")].value}'
```

(the exact env var name comes from `agent-orchestrator.config.staticIdentities`
in [values.yaml](../charts/agent-controller/values.yaml) — confirm the key in
your chart version with `kubectl -n controller-agent get deploy
agent-orchestrator -o yaml | less`). The token must appear as a key in that
JSON map, mapped to a `roles` list that covers whatever Skill/Tool you expect
to reach (e.g. `["reader","writer"]` — a reader-only token can starve out
skills whose derived audience requires `writer`, see
[orchestrator.md](orchestrator.md#2-skill-layer--tool-registryrag-index)).

## 5. Required secrets (create these yourself, never via `--set`)

The chart never creates application secrets — supply them out-of-band before
install/upgrade:

```sh
kubectl -n controller-agent create secret generic agent-orchestrator-secrets \
  --from-literal=OPENAI_API_KEY=<your-openai-api-key> \
  --from-literal=AGENT_CALLBACK_SECRET="$(openssl rand -hex 32)"
```

If you enabled Open WebUI's Google OAuth (`openwebui.sso.google.enabled:
true`), also create the OAuth client secret under the exact name referenced by
`openwebui.sso.google.clientExistingSecret`:

```sh
kubectl -n controller-agent create secret generic <clientExistingSecret-name> \
  --from-literal=client-secret=<google-oauth-client-secret>
```

Verify what actually exists before debugging further up the stack:

```sh
kubectl -n controller-agent get secrets
```

## 6. Inspecting `ToolRun` / `AgentRun` activity

Every message you send in the UI that selects a tool or delegates to a
sub-agent shows up as a `ToolRun` or `AgentRun` custom resource — this is the
Kubernetes-native audit trail described in
[controllers/core-controller/README.md](../controllers/core-controller/README.md#result-reporting).
No dashboard is required:

```sh
kubectl -n controller-agent get toolruns
kubectl -n controller-agent get agentruns
```

Both print `Phase` (`Pending`/`Running`/`Succeeded`/`Failed`), the owned `Job`
name, and age. To see why one failed:

```sh
kubectl -n controller-agent describe toolrun <name>
kubectl -n controller-agent logs job/<jobName-from-status>
```

`ToolRun.status.phase`/`AgentRun.status.phase` (mirrored from the owned Job)
is the authoritative lifecycle signal — the tool's own callback payload
carries the result *content*, not the pass/fail verdict.

## 7. Inspecting the catalog (`Tool` / `Skill` / `Agent`)

What the UI's underlying agent is *allowed* to do is entirely declared as
custom resources, discoverable with plain `kubectl get`/`describe` — no
redeploy needed to see what's registered:

```sh
kubectl -n controller-agent get tools
kubectl -n controller-agent get skills
kubectl -n controller-agent get agents
kubectl -n controller-agent describe tool <name>       # allowedRoles, image, secretEnv
kubectl -n controller-agent describe skill <name>       # toolRefs, markdown system prompt
```

Changes to these CRs (`kubectl apply -f ...`) take effect the next time the
orchestrator restarts (it reads the catalog once at startup — there's no
watch loop yet, see [orchestrator.md](orchestrator.md#open-questions-explicitly-deferred)),
so a `kubectl rollout restart deploy/agent-orchestrator` is expected after
editing a `Tool`/`Skill`/`Agent`.

## 8. Quick troubleshooting checklist

| Symptom | Check |
| ------- | ----- |
| Can't reach `localhost:8080` | Is the `port-forward` still attached? Is the Service name right (`kubectl get svc -l app.kubernetes.io/name=open-webui`)? |
| Chat immediately 401s | `openwebui.openaiApiKey` vs. `agent-orchestrator.config.staticIdentities` — see [§4](#4-auth-why-a-fresh-login-might-get-a-401) |
| Chat returns 0 candidate skills | Token's `roles` don't cover any Skill's derived `allowedRoles` — `kubectl describe tool <name>` for each tool a skill declares |
| A tool call never completes | `kubectl get toolruns` for its `Phase`; `Pending` stuck too long usually means the Job never scheduled — `kubectl describe job <jobName>` for scheduling/image-pull errors |
| Open WebUI Pod crash-looping | `kubectl -n controller-agent logs -l app.kubernetes.io/name=open-webui` — check for `OOMKilled` first (raise `openwebui.resources`) |
| New `Tool`/`Skill`/`Agent` not showing up in chat | `kubectl rollout restart deploy/agent-orchestrator` — catalog is read once at startup |

## Related

- [charts/agent-controller/README.md](../charts/agent-controller/README.md) — the Helm chart this guide assumes is already installed.
- [controllers/core-controller/README.md](../controllers/core-controller/README.md) — the CRDs (`Tool`/`Skill`/`Agent`/`ToolRun`/`AgentRun`) and the `kubectl`/`make` commands for installing/upgrading the controller itself.
- [orchestrator.md](orchestrator.md) — how the OpenAI-compatible facade and RBAC-scoped retrieval Open WebUI relies on actually work.
- [security.md](security.md) — the threat model behind the auth/secret handling referenced above.
