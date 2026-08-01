# kubectl-readonly

A self-contained subagent container: a single read-only kubectl command line
in, cluster state (text/JSON) out.

## Contract

- **Input** (`argv[2]`): everything after `kubectl`, e.g. `"get pods -n prod"`.
- **Output**: kubectl's own stdout, wrapped in a fenced code block, delivered
  via the event contract in `docs/messaging.md`.

## Safety model (defense in depth)

1. **RBAC** (`charts/community-components/templates/clusterrole-kubectl-readonly.yaml`)
   -- the launched Job's ServiceAccount can only `get`/`list`/`watch` a fixed
   set of resource kinds, cluster-wide. No write verbs, ever. No RBAC
   objects (Roles/RoleBindings/ClusterRoles/ClusterRoleBindings), no
   CustomResourceDefinitions or CRs.
2. **In-process allowlist** (`src/allowlist.ts`) -- independently rejects any
   verb other than `get`/`describe`/`logs`/`events`/`top`, any resource kind
   outside the same fixed list, and any flag outside a small read-only set
   (namespace/selector/container/tail/output/sort-by/...). A fixed
   `--request-timeout=10s` is always appended and cannot be overridden.
3. **No shell** -- the validated argv is passed straight to
   `child_process.spawn`, never interpolated into a shell string.
4. **No persisted kubeconfig** -- in-cluster auth reads the pod's projected
   ServiceAccount token/CA fresh on every invocation (`src/kubectl.ts`) and
   passes them as explicit `--server`/`--certificate-authority`/`--token`
   flags; nothing is written to disk (the container's root filesystem is
   read-only).

### Secrets: keys and lengths only, never values

`secrets` is in the allowed resource-kind list, but only for `get` (default
table output -- NAME/TYPE/DATA count/AGE, no values) and `describe` (which
prints each data key with its byte length, e.g. `password: 12 bytes`,
already redacted by kubectl itself -- never the decoded value). `-o
json`/`-o yaml` are explicitly rejected for `secrets` specifically (see
`RESOURCE_OUTPUT_RESTRICTIONS` in `src/allowlist.ts`), since those output
forms include the full base64-encoded `.data` field.

**This is an application-layer restriction, not an RBAC one** -- Kubernetes
RBAC has no field-level granularity, so granting `get`/`list` on `secrets`
at all means the API server will hand back full secret values to anything
holding this ServiceAccount's token, regardless of what this tool's CLI
does. The security boundary for "never return secret values" is this
codebase, not the cluster. See the PR description / `docs/security.md` for
the full trade-off discussion before enabling this in a cluster where that
isn't an acceptable risk.

## Resource kinds and verbs

An explicit **allowlist**, not "everything except secrets" -- see the
comment at the top of `src/allowlist.ts` for why a blocklist approach was
rejected (it would silently start exposing new/CRD resource kinds that
might embed credentials in spec fields, a real anti-pattern some operators
use instead of a proper Secret).

Deliberately excluded even though they're not literally "secret material":
RBAC objects (recon for privilege-escalation paths), CustomResourceDefinitions
and arbitrary CRs (unbounded/unknown content), and any mutating verb
(`create`/`update`/`patch`/`delete`/`apply`/`exec`/`cp`/`port-forward`/...).

## Local development

```sh
npm install
npm run typecheck --workspace=kubectl-readonly
npm run test --workspace=kubectl-readonly
npm run build --workspace=kubectl-readonly
docker build -f tools/kubectl-readonly/Dockerfile -t kubectl-readonly:latest .
./tools/kubectl-readonly/run.sh "get pods -n default"   # exercises kubectl against your local kubeconfig
```

To test the actual in-cluster auth path, enable
`kubectlReadonly.enabled=true` in `charts/community-components` and invoke it
as a real `ToolRun`/Job in a cluster (e.g. minikube).
