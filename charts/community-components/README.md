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
| `skills.recipeRefining` | Skill | extract -> confirm -> publish -> refine, using the two tools above | on |
| `skills.softwareEngineering` | Skill | superseded by `opencodeSweAgent` below; keep disabled when that's enabled | off |
| `opencodeSweAgent` | Agent | privileged GitHub coding sub-agent (opencode CLI + Anthropic API) | off |

See [values.yaml](values.yaml) for the full set of per-component knobs
(image, ServiceAccount, secret references).

## Prerequisites for enabled components

Each Tool/Agent CR references a ServiceAccount and Secret that this chart
does **not** create -- they must already exist in the namespace:

- `recipeScraper`: ServiceAccount `recipe-scraper`; Secret with `OPENAI_API_KEY`
  (default `agent-orchestrator-secrets`).
- `recipePublisher`: ServiceAccount `recipe-publisher`; Secret
  `recipe-publisher-secrets` with `MEALIE_API_TOKEN`.
- `opencodeSweAgent` (if enabled): ServiceAccount `opencode-swe-agent`; Secret
  `opencode-swe-secrets` with `GITHUB_TOKEN` and `ANTHROPIC_API_KEY`.

## Adding a new community component

1. Add a new `Tool`/`Skill`/`Agent` template under `templates/`, gated by an
   `enabled` flag in `values.yaml`, following the pattern in the existing
   templates.
2. Document any new ServiceAccount/Secret prerequisites above.
3. Bump `version` in `Chart.yaml`.
