This directory is intentionally empty in git. Helm's `crds/` convention
requires the CRD YAML to physically be here before `helm install` / `helm
template` / `helm package` will see it (`helm upgrade` never updates CRDs
already on a cluster from this dir, so this is install/package-time only).

The CRDs themselves are generated from `controllers/core-controller`'s
`*_types.go` via kubebuilder markers -- that's the source of truth, not this
copy. Populate this directory before using the chart locally:

```sh
cd controllers/core-controller
make manifests   # regenerates config/crd/bases/*.yaml AND copies them here
# or, if config/crd/bases/ is already current:
make sync-crds
```

CI (`.github/workflows/release.yml`, the `publish-charts` job) runs the same
sync before packaging, so published chart artifacts always carry current CRDs
even though this directory isn't committed.

**This directory does not keep a running cluster's CRDs current, and cannot.**
Because `helm upgrade` ignores `crds/`, an existing release never receives a
newly-added CRD and never receives a schema change to an existing one — and an
outdated schema is worse than a missing one, since the API server accepts CRs
that reference new fields and silently prunes those fields away. The
`release.yml` `deploy` job therefore applies
`controllers/core-controller/config/crd/bases/` with `kubectl apply
--server-side --force-conflicts` on every push, before either `helm upgrade`.
That step is the mechanism that keeps cluster CRDs current; this directory only
covers a first install and the packaged artifact.

## Cluster permission that step requires

CRDs are **cluster-scoped**. Every other `kubectl`/`helm` call in the `deploy`
job is namespaced, so this is the only thing in the pipeline needing
cluster-scoped rights — which is part of why the gap went unnoticed for so long.
The job runs on an in-cluster ARC runner with no kubeconfig step, so it
authenticates as that runner pod's own ServiceAccount, which is cluster
infrastructure this repository does not manage and cannot grant itself.

The step preflights the permission and fails with this same instruction rather
than surfacing a raw RBAC denial against whichever CRD happened to be applied
first. Grant the runner's ServiceAccount a ClusterRole containing:

```yaml
- apiGroups: ["apiextensions.k8s.io"]
  resources: ["customresourcedefinitions"]
  verbs: ["get", "list", "create", "update", "patch"]
```

No `delete`: nothing in the pipeline removes a CRD, and deleting one cascades to
every CR of that kind.
