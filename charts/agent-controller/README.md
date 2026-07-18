# agent-controller (system chart)

Deploys the **agent-controller system** as a single Helm release, using the
subcharts pattern — each component is a subchart that can be toggled
independently:

| Subchart (values key) | What it deploys | Default |
| --------------------- | --------------- | ------- |
| `agent-orchestrator` | Parent orchestrator Deployment, invoke/callback Services, RBAC; bundles an optional [Qdrant](charts/agent-orchestrator/) under `agent-orchestrator.qdrant.*` and an optional Redis session store under `agent-orchestrator.redis.*` | on |
| `core-controller` | The Go/kubebuilder operator + the Tool/Skill/ToolRun/Agent/AgentRun/LocalTool CRDs (from its `crds/` dir) | on |
| `openwebui` | Optional [Open WebUI](https://github.com/open-webui/open-webui) chat UI in front of the orchestrator's OpenAI-compatible facade | off |
| `nats` | Optional NATS JetStream server for the queue-based tool-result channel | off |

The Tool/Skill/Agent **catalog** (the actual custom resources tools/skills/
agents are registered as) is a separate top-level chart —
[charts/community-components](../community-components/) — installed as its
own release on top of this one.

## Layout

```
charts/agent-controller/
├── Chart.yaml                  # 4 dependencies (2 local file://, 2 remote: open-webui, nats)
├── values.yaml                 # per-subchart passthrough + enable toggles
├── values-minikube-demo.yaml   # the local minikube demo overrides (not packaged)
├── templates/NOTES.txt         # aggregate post-install guidance
└── charts/
    ├── agent-orchestrator/     # local subchart (with its own qdrant dependency)
    ├── core-controller/        # local subchart (ships the CRDs)
    ├── open-webui-*.tgz        # fetched remote dependency (gitignored)
    └── nats-*.tgz              # fetched remote dependency (gitignored)
```

## Prerequisites

- A Kubernetes cluster and `helm` 3.
- Secrets created out-of-band (never via `--set`), e.g. for the demo:
  - `agent-orchestrator-secrets` with `OPENAI_API_KEY` + `AGENT_CALLBACK_SECRET`

## Fetching dependencies

Helm does **not** recurse into nested subchart dependencies, so fetch the
orchestrator subchart's Qdrant first, then this chart's own dependencies:

```bash
helm dependency update charts/agent-controller/charts/agent-orchestrator   # qdrant
helm dependency update charts/agent-controller                             # open-webui, nats
```

> `helm dependency update` also writes redundant local subchart `.tgz` files
> next to the unpacked subchart dirs. These are harmless (gitignored, and Helm
> dedupes dir-vs-tgz at render time) — leave them or delete them, either works.
> Prefer `helm dependency build` (with `helm repo add open-webui
> https://helm.openwebui.com/` once) if you want to avoid touching the lock.

## Install

```bash
helm install agent-controller charts/agent-controller -n controller-agent --create-namespace \
  -f charts/agent-controller/values-minikube-demo.yaml
```

Then install the catalog on top: see
[charts/community-components/README.md](../community-components/README.md).

### Installing the published chart

This chart is also published as an OCI artifact to GHCR on every merge to
`main` that touches `charts/**`:

```bash
helm install agent-controller oci://ghcr.io/imaustink/charts/agent-controller \
  --version 0.1.0 -n controller-agent --create-namespace -f my-values.yaml
```

For the local minikube workflow (build images into minikube, apply CRDs, then
this install/upgrade), use [scripts/dev-up.sh](../../scripts/dev-up.sh).

Always upgrade with the same values file so previously-set overrides aren't
dropped (see the header comment in `values-minikube-demo.yaml`):

```bash
helm upgrade agent-controller charts/agent-controller -n controller-agent \
  -f charts/agent-controller/values-minikube-demo.yaml
```

## Notable behaviors

- **Stable Service/Deployment names.** `agent-orchestrator.fullnameOverride` and
  `core-controller.fullnameOverride` pin the orchestrator's
  `agent-orchestrator-invoke`/`-callback` Services and the `core-controller` /
  `agent-orchestrator` Deployment names regardless of the release name — the
  Open WebUI base URL and the in-cluster callback URL depend on those names.
- **Ordering.** The controller's CRDs install first (Helm processes every
  subchart's `crds/` dir before any templated resource). Install this chart
  before `community-components`, whose Tool/Skill/Agent CRs require those
  CRDs to already exist.
- **CRDs are never removed by Helm.** Uninstalling this release leaves the
  CRDs (and thus any surviving `community-components` CRs) in place; delete
  them explicitly if you want a full teardown.

## Values

See [values.yaml](values.yaml) for the full set. Each top-level key maps to a
subchart and is passed straight through; consult the subcharts' own
`values.yaml` files for their complete knobs.

## Operating Open WebUI after install

For reaching the chat UI, verifying it's healthy, and inspecting
`ToolRun`/`AgentRun`/`Tool`/`Skill`/`Agent` resources with plain `kubectl`
(no Helm/dashboard needed), see
[docs/kubectl-ui-guide.md](../../docs/kubectl-ui-guide.md).
