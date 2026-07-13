# recipe-agent (umbrella Helm chart)

Deploys the **whole recipe-agent system as a single Helm release**, using the
subcharts pattern — each component is a subchart that can be toggled
independently:

| Subchart (values key) | What it deploys | Default |
| --------------------- | --------------- | ------- |
| `agent-orchestrator` | Parent orchestrator Deployment, invoke/callback Services, RBAC; bundles an optional [Qdrant](charts/agent-orchestrator/) under `agent-orchestrator.qdrant.*` | on |
| `tool-controller` | The Go/kubebuilder operator + the Tool/Skill/ToolRun/Agent/AgentRun/LocalTool CRDs (from its `crds/` dir) | on |
| `tools` | The Tool + Skill catalog (custom resources) — applied as post-install/post-upgrade hooks so they land after the controller | on |
| `openwebui` | Optional [Open WebUI](https://github.com/open-webui/open-webui) chat UI in front of the orchestrator's OpenAI-compatible facade | off |

This replaces the two previously-separate releases (`agent-orchestrator` and
`tool-controller`) with one `recipe-agent` release.

## Layout

```
charts/recipe-agent/
├── Chart.yaml                  # 4 dependencies (3 local file://, 1 remote open-webui)
├── values.yaml                 # per-subchart passthrough + enable toggles
├── values-minikube-demo.yaml   # the local minikube demo overrides (not packaged)
├── templates/NOTES.txt         # aggregate post-install guidance
└── charts/
    ├── agent-orchestrator/     # local subchart (with its own qdrant dependency)
    ├── tool-controller/        # local subchart (ships the CRDs)
    ├── tools/                  # local subchart (Tool/Skill CRs)
    └── open-webui-*.tgz        # fetched remote dependency (gitignored)
```

## Prerequisites

- A Kubernetes cluster and `helm` 3.
- Secrets created out-of-band (never via `--set`), e.g. for the demo:
  - `agent-orchestrator-secrets` with `OPENAI_API_KEY` + `AGENT_CALLBACK_SECRET`
  - `recipe-publisher-secrets` with `MEALIE_API_TOKEN`
  - (optional) `copilot-swe-secrets` for the privileged `copilot-swe` tool
- The tool ServiceAccounts referenced by the catalog CRs must exist
  (`recipe-scraper`, `recipe-publisher`, and `copilot-swe` if enabled) — this
  chart never creates tool ServiceAccounts.

## Fetching dependencies

Helm does **not** recurse into nested subchart dependencies, so fetch the
orchestrator subchart's Qdrant first, then the umbrella's Open WebUI:

```bash
helm dependency update charts/recipe-agent/charts/agent-orchestrator   # qdrant
helm dependency update charts/recipe-agent                             # open-webui
```

> `helm dependency update` also writes redundant local subchart `.tgz` files
> next to the unpacked subchart dirs. These are harmless (gitignored, and Helm
> dedupes dir-vs-tgz at render time) — leave them or delete them, either works.
> Prefer `helm dependency build` (with `helm repo add open-webui
> https://helm.openwebui.com/` once) if you want to avoid touching the lock.

## Install

```bash
helm install recipe-agent charts/recipe-agent -n recipe-agent --create-namespace \
  -f charts/recipe-agent/values-minikube-demo.yaml
```

For the local minikube workflow (build images into minikube, apply CRDs, then
this install/upgrade), use [scripts/dev-up.sh](../../scripts/dev-up.sh).

Always upgrade with the same values file so previously-set overrides aren't
dropped (see the header comment in `values-minikube-demo.yaml`):

```bash
helm upgrade recipe-agent charts/recipe-agent -n recipe-agent \
  -f charts/recipe-agent/values-minikube-demo.yaml
```

## Notable behaviors

- **Stable Service/Deployment names.** `agent-orchestrator.fullnameOverride` and
  `tool-controller.fullnameOverride` pin the orchestrator's
  `agent-orchestrator-invoke`/`-callback` Services and the `tool-controller` /
  `agent-orchestrator` Deployment names regardless of the release name — the
  Open WebUI base URL and the in-cluster callback URL depend on those names.
- **Ordering.** The controller's CRDs install first (Helm processes every
  subchart's `crds/` dir before any templated resource). The catalog's
  Tool/Skill CRs are `post-install,post-upgrade` hooks, so they apply after the
  controller Deployment is created; with `--wait` they run after it is ready.
- **Uninstall caveat.** Because the catalog CRs are Helm hooks, `helm uninstall`
  does **not** delete them. Remove them by hand if needed:
  `kubectl -n <ns> delete tool,skill -l app.kubernetes.io/part-of=recipe-agent`.
  (CRDs, installed from `crds/`, are also never removed by Helm.)

## Values

See [values.yaml](values.yaml) for the full set. Each top-level key maps to a
subchart and is passed straight through; consult the subcharts' own
`values.yaml` files for their complete knobs. Per-Tool/Skill toggles and
image/secret settings live in [charts/tools/values.yaml](charts/tools/values.yaml).
