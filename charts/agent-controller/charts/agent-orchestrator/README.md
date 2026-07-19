# agent-orchestrator (Helm chart)

> **This is now a subchart of the [controller-agent umbrella chart](../../).**
> Deploy the whole system as one release with `charts/agent-controller` instead of
> installing this chart standalone. Open WebUI and the committed
> `values-minikube-demo.yaml` moved up to the umbrella level; the standalone
> `helm install`/Open WebUI/upgrade instructions below are retained only for
> using this chart on its own. This chart still bundles its own optional Qdrant.

Deploys [apps/agent-orchestrator](../../../../apps/agent-orchestrator/) — the
parent orchestrator — to Kubernetes. See that app's
[README](../../../../apps/agent-orchestrator/README.md) and
[docs/orchestrator.md](../../../../docs/orchestrator.md) for what it does; this
chart just wires it up as cluster resources.

## What it creates

- A `Deployment` running the orchestrator image, with the hardened pod/
  container `securityContext` from [docs/security.md](../../docs/security.md)
  (non-root, read-only root filesystem, all capabilities dropped, no
  privilege escalation) — mirrors `run.sh`'s local hardened-run contract.
- Two separate `Service` objects for the orchestrator's two ports (ADR 0006),
  so they can be exposed/policed independently:
  - `<release>-invoke` (`AGENT_HTTP_PORT`, default 8081) — consumer-facing
    `POST /invoke` / `GET /invoke/:id` / `/v1/*` OpenAI-compatible facade.
  - `<release>-callback` (`AGENT_CALLBACK_PORT`, default 8080) — in-cluster
    only, receives job results from launched tool/sub-agent Jobs.
- A `ServiceAccount` + namespace-scoped `Role`/`RoleBinding` (never a
  `ClusterRole`) granting exactly what the code uses: `create/get/list/watch/delete`
  on `jobs` (ADR 0005) — nothing else. Tool discovery no longer touches the
  k8s API (ADR 0009: the catalog is a static manifest baked into the
  orchestrator image), so this Role doesn't need any `apps/deployments`
  permissions. Bound in the namespace Jobs are launched into (`namespace`
  value, defaults to the release namespace).
- Optional `Ingress` (invoke service only — the callback service is never
  routed through an Ingress), `NetworkPolicy` pair, and `HorizontalPodAutoscaler`,
  all disabled by default.

## Prerequisites

- A reachable Qdrant instance (`config.qdrantUrl`) — not included by default.
  Either point it at an existing deployment, or set `qdrant.enabled=true` to
  deploy a bundled single-replica instance via the official
  [qdrant-helm](https://github.com/qdrant/qdrant-helm) chart as a dependency
  (see "Bundled Qdrant" below); the latter is meant for local/dev/demo use,
  not production.
- An `OPENAI_API_KEY` and an `AGENT_CALLBACK_SECRET` (must not be guessable —
  it HMAC-authenticates Job → orchestrator callbacks). Provide these via
  `secrets.existingSecret` (recommended — a Secret you manage separately,
  e.g. via an external-secrets operator) or `secrets.create=true` with
  `secrets.openaiApiKey` / `secrets.callbackSecret` (dev/local convenience
  only — these values land in the stored Helm release values in plaintext).
- ServiceAccounts matching each tool manifest's `serviceAccountName` (e.g.
  `recipe-scraper`, `recipe-publisher`), created in the same namespace Jobs
  are launched into — these are what the launched tool Jobs actually run as,
  distinct from the orchestrator's own ServiceAccount above. The tool
  catalog itself (which tools exist, what they do, how to launch them) is
  baked into the orchestrator image at build time — see
  [the app README's "Registering a tool"](../../apps/agent-orchestrator/README.md#registering-a-tool)
  (ADR 0009) — there's nothing to annotate/create in the cluster for
  discovery purposes.

## Bundled Qdrant (optional)

Set `qdrant.enabled=true` to deploy a single-replica Qdrant alongside the
orchestrator, using the official chart as a dependency (declared in
`Chart.yaml`, condition `qdrant.enabled`). Run this once before
`helm install`/`helm upgrade`/`helm package` so the dependency is fetched
locally:

```bash
helm dependency update charts/agent-controller/charts/agent-orchestrator
```

`config.qdrantUrl` is ignored when this is on — the orchestrator's
`AGENT_QDRANT_URL` is derived automatically to point at the subchart's
in-cluster Service. Values under the `qdrant:` key (`qdrant.replicaCount`,
`qdrant.persistence.size`, `qdrant.resources`, `qdrant.apiKey`, etc.) pass
straight through to that subchart — see its own
[values.yaml](https://github.com/qdrant/qdrant-helm/blob/main/charts/qdrant/values.yaml)
for the full list. This path has no backup/disaster-recovery story (single
replica, no automated snapshots) — fine for local/dev, not a production
Qdrant deployment.

## Bundled Open WebUI (optional)

Set `openwebui.enabled=true` to deploy [Open WebUI](https://github.com/open-webui/open-webui)
(a ChatGPT-like UI) alongside the orchestrator, using the official chart
(`https://helm.openwebui.com/`) as a dependency aliased to lowercase
`openwebui` (declared in `Chart.yaml`, condition `openwebui.enabled` --
lowercase/no-hyphen because the subchart bakes its alias verbatim into k8s
object names, which must be valid DNS-1123 labels). Run this once before
`helm install`/`helm upgrade`/`helm package` so the dependency is fetched
locally (same command as above, it fetches every enabled dependency):

```bash
helm dependency update charts/agent-orchestrator
```

It's wired to talk to this release's own invoke Service via
`openwebui.openaiBaseApiUrl` (the orchestrator's ADR 0007 OpenAI-compatible
facade), with `ollama.enabled`/`pipelines.enabled` forced off since only the
orchestrator backend is needed. **Auth caveat**: Open WebUI sends
`openwebui.openaiApiKey` as a plain bearer token on every request, and the
orchestrator's dev/test-only `StaticIdentityResolver` rejects anything not
in `config.staticIdentities` — set both to the same value, e.g.:

```bash
helm upgrade agent-orchestrator charts/agent-orchestrator -n controller-agent --reuse-values \
  --set openwebui.enabled=true \
  --set openwebui.openaiApiKey=<some-token> \
  --set config.staticIdentities='{"<some-token>":{"subject":"open-webui","roles":["reader"]}}'
```

Values under the `openwebui:` key pass straight through to that subchart —
see its own [values.yaml](https://github.com/open-webui/helm-charts/blob/main/charts/open-webui/values.yaml)
for the full list (e.g. `openwebui.ingress.enabled` to expose it, or
`openwebui.persistence.size`). Like the bundled Qdrant, this is meant for
local/dev/demo use, not a production posture.

**Note**: Open WebUI's own auxiliary task features (title/tags/follow-up/
search-query generation) default to using whatever chat model is configured
— since `agent-orchestrator` is a full tool-invoking agent, not a plain chat
model, leaving these enabled means routine chat housekeeping (e.g.
auto-titling a new conversation) silently triggers a REAL second agent
invocation (skill selection + tool Job launch) per message. Disable them via
Open WebUI's own Admin Settings UI, or its `POST /api/v1/tasks/config/update`
API, once you've signed in.

### Google OAuth login (optional)

Set `openwebui.sso.enabled=true` + `openwebui.sso.google.enabled=true` to add
a "Continue with Google" button (in addition to, not instead of, local email/
password accounts). Disabled by default. Setup:

1. Google Cloud Console → APIs & Services → Credentials → Create Credentials
   → OAuth client ID → Application type "Web application".
2. Authorized redirect URI must exactly match how you access Open WebUI —
   for the port-forward workflow above: `http://localhost:8080/oauth/google/login/callback`.
3. Create the client secret as a Secret yourself (never via `--set`/chat, so
   it never lands in stored Helm release values):
   ```bash
   kubectl create secret generic agent-orchestrator-openwebui-google-oauth \
     -n controller-agent --from-literal=client-secret=<GOOGLE_CLIENT_SECRET>
   ```
4. Upgrade with the client ID (not secret — safe to commit/pass via `--set`)
   and the Secret name from step 3. **Prefer adding these to a values file
   (see "Upgrading this deployment" below) over ad-hoc `--set` flags** — a
   bare `--set`-only upgrade replaces the ENTIRE values tree, silently
   dropping any previously-set flags not repeated in the same command (this
   has actually happened in this deployment's history, see that section):
   ```bash
   helm upgrade agent-orchestrator charts/agent-orchestrator -n controller-agent \
     --set openwebui.enabled=true \
     --set openwebui.sso.enabled=true \
     --set openwebui.sso.google.enabled=true \
     --set openwebui.sso.google.clientId=<GOOGLE_CLIENT_ID> \
     --set openwebui.sso.google.clientExistingSecret=agent-orchestrator-openwebui-google-oauth
   ```

`openwebui.extraEnvVars` already sets `GOOGLE_REDIRECT_URI` to match the
port-forward URL above — override it (or add an Ingress-based one) if you
access Open WebUI differently.

## Upgrading this deployment (minikube demo)

This repo's own minikube demo deployment (namespace `controller-agent`) has a
committed [`values-minikube-demo.yaml`](values-minikube-demo.yaml) capturing
every override it actually needs (image tag, bundled Qdrant, existing
secret, dev bearer token, Google OAuth client id/secret ref). **Always
upgrade with it, never with hand-assembled `--set` flags**:

```bash
helm upgrade agent-orchestrator charts/agent-orchestrator -n controller-agent \
  -f charts/agent-orchestrator/values-minikube-demo.yaml
```

This exists because a plain `--set`-only `helm upgrade` (with no `-f`/
`--reuse-values`) replaces the ENTIRE computed values tree with just those
flags over the chart's bare defaults — it does NOT merge with the previous
revision. This has actually happened here: an upgrade that only passed new
Google OAuth flags silently reverted `image.tag` (breaking image pulls),
`qdrant.enabled` (deleting the bundled Qdrant pod — its PVC survived, so no
data was lost, but the pod still had to be recreated), and the orchestrator's
secrets/auth config. Edit `values-minikube-demo.yaml` first for any new
setting, then re-run the same command above.

## Install

```bash

```bash
# Build the image first (from the repo root):
docker build -f apps/agent-orchestrator/Dockerfile -t agent-orchestrator:latest .

helm install agent-orchestrator ./charts/agent-orchestrator \
  --set image.repository=agent-orchestrator \
  --set image.tag=latest \
  --set config.qdrantUrl=http://qdrant.default.svc.cluster.local:6333 \
  --set secrets.existingSecret=agent-orchestrator-secrets
```

Or copy `values.yaml` to a `my-values.yaml` and run
`helm install agent-orchestrator ./charts/agent-orchestrator -f my-values.yaml`.

## Values

See [values.yaml](values.yaml) for the full, commented list. Key ones:

| Key | Description | Default |
| --- | ----------- | ------- |
| `image.repository` / `image.tag` | orchestrator image | `agent-orchestrator` / chart `appVersion` |
| `namespace` | namespace tools are discovered in / Jobs launched into | release namespace |
| `config.qdrantUrl` | Qdrant endpoint (ignored if `qdrant.enabled=true`) | `http://qdrant:6333` |
| `qdrant.enabled` | deploy a bundled single-replica Qdrant (dev/demo only, see above) | `false` |
| `secrets.existingSecret` | Secret name providing `OPENAI_API_KEY` / `AGENT_CALLBACK_SECRET` | `""` |
| `secrets.create` | chart-managed Secret from `secrets.openaiApiKey`/`secrets.callbackSecret` (dev only) | `false` |
| `ingress.enabled` | expose the invoke Service via Ingress | `false` |
| `networkPolicy.enabled` | apply the invoke/callback NetworkPolicy pair | `false` |
| `config.identityResolver` | `static` (dev/test) or `oidc` (verify caller bearer tokens as JWTs) | `static` |
| `config.staticIdentities` | DEV/TEST-ONLY bearer-token map, used when `identityResolver=static` | unset |
| `config.oidcIssuer` / `config.oidcJwksUri` | required when `identityResolver=oidc`: expected JWT issuer and JWKS endpoint | unset |
| `config.oidcAudience` | expected JWT audience; unset skips audience verification | unset |
| `config.oidcRolesClaim` | dot-path to the roles claim, e.g. `realm_access.roles` (Keycloak) | `roles` |
| `openwebui.enabled` | deploy a bundled Open WebUI chat UI (dev/demo only, see above) | `false` |
| `openwebui.openaiApiKey` | bearer token Open WebUI sends — must match a key in `config.staticIdentities` (static resolver only) | `""` |

## Known gaps

Same ones documented in the
[app README's "Known gaps"](../../apps/agent-orchestrator/README.md#known-gaps-by-design-not-yet-implemented)
section — this chart doesn't work around any of them (e.g. invocation state
is in-memory only, so multi-replica/
`autoscaling.enabled` deployments won't share `/invoke/:id` state across
pods yet).
