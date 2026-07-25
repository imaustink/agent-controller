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
