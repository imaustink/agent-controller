# community-components

The community catalog of `Tool`, `Skill`, and `Agent` custom resources
(ADR 0010/0011) that the agent-controller's core-controller operator
reconciles and the orchestrator RAG-selects. Installed as its own release,
independent of the [agent-controller](../agent-controller/) chart, so the
catalog can grow, version, and be upgraded/uninstalled on its own schedule.

## Prerequisite

The `agent-controller` chart must already be installed in the cluster --
this chart's CRs (`Tool`/`Skill`/`Agent`) require the
`Tool`/`Skill`/`Agent`/`ToolRun`/`AgentRun`/`LocalTool` CRDs that chart's
`core-controller` subchart installs. Installing this chart first will fail
(the API group `core.controller-agent.dev/v1alpha1` won't exist yet).

## Install

```bash
helm install community-components charts/community-components -n controller-agent
```

Upgrade the same way with `helm upgrade`. Because every resource here is a
normal (non-hook) Helm-managed template, `helm uninstall community-components`
cleanly removes all the `Tool`/`Skill`/`Agent` CRs it created.

### Installing the published chart

This chart is also published as an OCI artifact to GHCR on every merge to
`main` that touches `charts/**`:

```bash
helm install community-components oci://ghcr.io/imaustink/charts/community-components \
  --version 0.1.0 -n controller-agent
```

## Contents

| Values key | Kind | What it is | Default |
| ---------- | ---- | ---------- | ------- |
| `recipeScraper` | Tool | URL -> recipe Markdown extraction | on |
| `recipePublisher` | Tool | publishes/updates a recipe on Mealie | on |
| `webSearch` | Tool | queries an in-cluster SearXNG instance for web results | off |
| `skills.recipeRefining` | Skill | extract -> confirm -> publish -> refine, using the two tools above | on |
| `skills.softwareEngineering` | Skill | superseded by `opencodeSweAgent` below; keep disabled when that's enabled | off |
| `opencodeSweAgent` | Agent | privileged GitHub coding sub-agent (opencode CLI + Anthropic API) | off |

See [values.yaml](values.yaml) for the full set of per-component knobs
(image, ServiceAccount, secret references).

## Prerequisites for enabled components

Each Tool/Agent CR's ServiceAccount is created by this chart by default (see
`<component>.serviceAccount.create` in values.yaml). What's still required
out-of-band is:

- `recipeScraper`: Secret with `OPENAI_API_KEY` (default
  `agent-orchestrator-secrets`).
- `recipePublisher`: `recipePublisher.mealieBaseUrl` must be set to your own
  Mealie instance (no default -- install fails without it); Secret
  `recipe-publisher-secrets` with `MEALIE_API_TOKEN`.
- `webSearch` (if enabled): the `agent-controller` release's
  `searxng.enabled=true`, and `webSearch.searxngBaseUrl` pointed at that
  release's SearXNG Service (defaults to the minikube demo release name).
- `opencodeSweAgent` (if enabled): Secret `opencode-swe-secrets` with
  `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`.

Every tool/agent image (`recipeScraper.image`, `recipePublisher.image`,
`webSearch.image`, `opencodeSweAgent.image`) also needs to point at a registry
you actually have access to -- see the top-level
[agent-controller README](../agent-controller/README.md#prerequisites).

## Adding a new community component

1. Add a new `Tool`/`Skill`/`Agent` template under `templates/`, gated by an
   `enabled` flag in `values.yaml`, following the pattern in the existing
   templates. This chart is the only place these CRs are defined -- there is
   no separate plain-CR copy for manual `kubectl apply` to keep in sync;
   `.github/workflows/validate-crds.yml` validates by rendering this chart
   with every component enabled and dry-run applying that output.
2. Document any new ServiceAccount/Secret prerequisites above.
3. Bump `version` in `Chart.yaml`.
