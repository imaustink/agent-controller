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

CI (`.github/workflows/publish-charts.yml`) runs the same sync before
packaging, so published chart artifacts always carry current CRDs even
though this directory isn't committed.
