# kubectl-readonly

A self-contained subagent container: a single read-only kubectl command line
in, cluster state (text/JSON) out. Part of the `cluster-debug-skill` (see
`apps/agent-orchestrator/config/samples/cluster-debug-skill.yaml`).

## Contract

- **Input** (`argv[2]`): everything after `kubectl`, e.g. `"get pods -n prod"`.
- **Output**: kubectl's own stdout, wrapped in a fenced code block, delivered
  via the event contract in `docs/messaging.md`.

## Safety model (defense in depth)

1. **RBAC** (`rbac.yaml`) — the launched Job's ServiceAccount can only
   `get`/`list`/`watch` a fixed set of non-sensitive resource kinds, cluster-wide.
   No Secrets, no RBAC objects, no write verbs, ever.
2. **In-process allowlist** (`src/allowlist.ts`) — independently rejects any
   verb other than `get`/`describe`/`logs`/`events`/`top`, any resource kind
   outside the same fixed list, and any flag outside a small read-only set
   (namespace/selector/container/tail/output/sort-by/...). A fixed
   `--request-timeout=10s` is always appended and cannot be overridden.
3. **No shell** — the validated argv is passed straight to
   `child_process.spawn`, never interpolated into a shell string.
4. **No persisted kubeconfig** — in-cluster auth reads the pod's projected
   ServiceAccount token/CA fresh on every invocation (`src/kubectl.ts`) and
   passes them as explicit `--server`/`--certificate-authority`/`--token`
   flags; nothing is written to disk (the container's root filesystem is
   read-only).

## Local development

```sh
npm install
npm run typecheck --workspace=kubectl-readonly
npm run test --workspace=kubectl-readonly
npm run build --workspace=kubectl-readonly
docker build -f tools/kubectl-readonly/Dockerfile -t kubectl-readonly:latest .
./tools/kubectl-readonly/run.sh "get pods -n default"   # exercises kubectl against your local kubeconfig
```

To test the actual in-cluster auth path, apply `rbac.yaml` and `tool.yaml`
and invoke it as a real `ToolRun`/Job in a cluster (e.g. minikube).
