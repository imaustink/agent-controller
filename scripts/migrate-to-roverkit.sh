#!/usr/bin/env bash
# migrate-to-roverkit.sh — move a live cluster from the core.controller-agent.dev
# API group to core.roverkit.io (docs/roverkit-migration.md, ADR 0047).
#
# Usage:  ./scripts/migrate-to-roverkit.sh copy    [--dry-run]   # BEFORE the upgrade
#         ./scripts/migrate-to-roverkit.sh cleanup [--dry-run]   # AFTER it is healthy
#
# ## Why two phases
#
# The old and new groups are unrelated to Kubernetes: different CRDs, so every
# object has to be recreated, never converted. Doing it in two halves keeps the
# running release untouched until the new one is ready to take over:
#
#   copy     installs the new CRDs, recreates every hand-applied CR under the new
#            group, and ADDS the new label/annotation keys to credential Secrets
#            next to the old ones. The old release only reads the old group and
#            old keys, so nothing it does changes.
#   cleanup  re-runs copy (catching anything the old release wrote while you
#            upgraded), then removes the old finalizers, CRs and CRDs, and the old
#            keys on Secrets.
#
# Only HAND-APPLIED CRs are copied. Anything a release manages (Helm or Argo
# ownership metadata) is left for the upgrade to create from the new chart:
# Helm adopts an existing object without patching it, so a copy would pin the
# old chart's content -- including text that still names the old group.
# Runtime records are not copied either: AgentRun, ToolRun (a run belongs to
# whichever release launched it) and MCPTool (mcp-broker rebuilds them).
#
# Idempotent: copy never overwrites an object that already exists in the new
# group, so re-running it is safe after the new release has started writing.

set -euo pipefail

OLD_GROUP="core.controller-agent.dev"
NEW_GROUP="core.roverkit.io"
VERSION="v1alpha1"
AUTHORED=(agents tools skills localtools identityproviders integrationroutes connections corpora knowledgebases mcpservers)
RUNTIME=(agentruns toolruns mcptools)
FIELD_MANAGER="roverkit-migrate"
CRD_DIR="$(cd "$(dirname "$0")/.." && pwd)/orchestrator/controllers/core-controller/config/crd/bases"

PHASE="${1:-}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true
case "$PHASE" in
  copy|cleanup) ;;
  *) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
for bin in kubectl jq; do
  command -v "$bin" >/dev/null || { echo "✗ $bin is required" >&2; exit 1; }
done

# Rewrites a label/annotation/finalizer key into the roverkit domain. Keys
# outside the old domains (app.kubernetes.io/*, meta.helm.sh/*) pass through,
# so Helm and Argo ownership survives the copy and they adopt the new objects.
# shellcheck disable=SC2016 # jq's $p, not a shell expansion
JQ_RK='def rk: if test("/") then
    (split("/") as $p
      | ($p[0] | sub("controller-agent\\.dev$"; "roverkit.io") | sub("^controller-agent\\.io$"; "roverkit.io"))
        + "/" + ($p[1:] | join("/")))
  else . end;
  def rkmap: if . == null then null else with_entries(.key |= rk) end;
  def managed: (.metadata.labels // {})["app.kubernetes.io/managed-by"] == "Helm"
    or (.metadata.annotations // {})["meta.helm.sh/release-name"] != null
    or (.metadata.annotations // {})["argocd.argoproj.io/tracking-id"] != null;
  def old_keys: (. // {}) | keys | map(select(test("^([a-z0-9.-]*\\.)?controller-agent\\.dev/|^controller-agent\\.io/")));'

# stderr, so a dry run still shows calls whose output is discarded.
run() {
  if $DRY_RUN; then echo "  [dry-run] $*" >&2; else "$@"; fi
}

has_crd() { kubectl get crd "$1" >/dev/null 2>&1; }

CTX="$(kubectl config current-context 2>/dev/null || true)"
echo "Context: ${CTX:-<none>}"
echo "Phase:   $PHASE$($DRY_RUN && echo ' (dry run)')"
echo ""
if ! $DRY_RUN; then
  read -r -p "Run the $PHASE phase against this cluster? [y/N] " reply
  [[ "$reply" == "y" || "$reply" == "Y" ]] || { echo "Aborted."; exit 1; }
fi

install_new_crds() {
  echo "── Installing $NEW_GROUP CRDs from $CRD_DIR"
  [[ -d "$CRD_DIR" ]] || { echo "✗ $CRD_DIR not found; run from a checkout of the new version" >&2; exit 1; }
  run kubectl apply --server-side --field-manager="$FIELD_MANAGER" -f "$CRD_DIR"
  if ! $DRY_RUN; then
    for plural in "${AUTHORED[@]}" "${RUNTIME[@]}"; do
      kubectl wait --for=condition=Established --timeout=60s "crd/$plural.$NEW_GROUP" >/dev/null
    done
  fi
}

copy_crs() {
  echo "── Recreating hand-applied CRs under $NEW_GROUP"
  local copied=0 existing=0 managed=0
  for plural in "${AUTHORED[@]}"; do
    has_crd "$plural.$OLD_GROUP" || continue
    managed=$((managed + $(kubectl get "$plural.$OLD_GROUP" -A -o json | jq "$JQ_RK"'[.items[] | select(managed)] | length')))
  done
  for plural in "${AUTHORED[@]}"; do
    has_crd "$plural.$OLD_GROUP" || continue
    while IFS= read -r obj; do
      [[ -z "$obj" ]] && continue
      local ns name
      ns="$(jq -r '.metadata.namespace' <<<"$obj")"
      name="$(jq -r '.metadata.name' <<<"$obj")"
      if kubectl -n "$ns" get "$plural.$NEW_GROUP" "$name" >/dev/null 2>&1; then
        existing=$((existing + 1)); continue
      fi
      local fresh status
      fresh="$(jq -c "$JQ_RK"'
        {apiVersion: "'"$NEW_GROUP/$VERSION"'", kind, spec,
         metadata: ({name: .metadata.name, namespace: .metadata.namespace,
                     labels: (.metadata.labels | rkmap),
                     annotations: ((.metadata.annotations // {})
                       | del(."kubectl.kubernetes.io/last-applied-configuration") | rkmap),
                     finalizers: ((.metadata.finalizers // []) | map(rk))}
                    | with_entries(select(.value != null and .value != {} and .value != [])))}
        | with_entries(select(.value != null))' <<<"$obj")"
      status="$(jq -c '.status // empty' <<<"$obj")"
      echo "  + $plural $ns/$name"
      if jq -e '.spec | tostring | test("controller-agent\\.(dev|io)")' <<<"$obj" >/dev/null; then
        echo "    ⚠ its spec still mentions controller-agent.dev/.io; update it by hand"
      fi
      if $DRY_RUN; then copied=$((copied + 1)); continue; fi
      kubectl create --field-manager="$FIELD_MANAGER" -f - <<<"$fresh" >/dev/null
      if [[ -n "$status" ]]; then
        # Best effort: controllers recompute status, this only avoids a cold start.
        kubectl -n "$ns" patch "$plural.$NEW_GROUP" "$name" --subresource=status --type=merge \
          -p "{\"status\":$status}" >/dev/null 2>&1 || echo "    (status not copied; it will be recomputed)"
      fi
      copied=$((copied + 1))
    done < <(kubectl get "$plural.$OLD_GROUP" -A -o json | jq -c "$JQ_RK"'.items[] | select(managed | not)')
  done
  echo "  $copied recreated, $existing already present, $managed release-managed (the upgrade recreates those)"
}

# Adds (copy) or removes (cleanup) keys on Secrets and ConfigMaps. The
# credential stores find Secrets by label selector, so a Secret missing the new
# keys is invisible to the new release: every linked account would vanish.
relabel_stores() {
  local mode="$1"
  echo "── $([[ $mode == add ]] && echo Adding roverkit.io keys to || echo Removing old keys from) Secrets/ConfigMaps"
  local n=0
  for kind in secrets configmaps; do
    while IFS= read -r obj; do
      [[ -z "$obj" ]] && continue
      local ns name patch
      ns="$(jq -r '.metadata.namespace' <<<"$obj")"
      name="$(jq -r '.metadata.name' <<<"$obj")"
      if [[ "$mode" == add ]]; then
        patch="$(jq -c "$JQ_RK"'
          .metadata as $m
          | {metadata: {
              labels: ($m.labels | old_keys | map({key: rk, value: $m.labels[.]}) | from_entries),
              annotations: ($m.annotations | old_keys | map({key: rk, value: $m.annotations[.]}) | from_entries)}}' <<<"$obj")"
      else
        patch="$(jq -c "$JQ_RK"'
          .metadata as $m
          | {metadata: {
              labels: ($m.labels | old_keys | map({key: ., value: null}) | from_entries),
              annotations: ($m.annotations | old_keys | map({key: ., value: null}) | from_entries)}}' <<<"$obj")"
      fi
      echo "  ~ $kind $ns/$name"
      run kubectl -n "$ns" patch "$kind" "$name" --type=merge -p "$patch" >/dev/null
      n=$((n + 1))
    done < <(kubectl get "$kind" -A -o json | jq -c "$JQ_RK"'
      .items[] | select(((.metadata.labels | old_keys) + (.metadata.annotations | old_keys)) | length > 0)')
  done
  echo "  $n updated"
}

verify_every_cr_copied() {
  echo "── Checking every authored CR exists under $NEW_GROUP"
  local missing=0
  for plural in "${AUTHORED[@]}"; do
    has_crd "$plural.$OLD_GROUP" || continue
    while IFS=$'\t' read -r ns name; do
      [[ -z "$name" ]] && continue
      kubectl -n "$ns" get "$plural.$NEW_GROUP" "$name" >/dev/null 2>&1 || {
        echo "  ✗ $plural $ns/$name has no $NEW_GROUP copy"; missing=$((missing + 1)); }
    done < <(kubectl get "$plural.$OLD_GROUP" -A -o json | jq -r '.items[] | [.metadata.namespace, .metadata.name] | @tsv')
  done
  if (( missing > 0 )); then
    echo "✗ $missing CR(s) not copied; nothing deleted." >&2
    echo "  Release-managed CRs are created by the upgrade: upgrade (or sync) the release first." >&2
    exit 1
  fi
}

delete_old() {
  echo "── Removing $OLD_GROUP CRs and CRDs"
  for plural in "${AUTHORED[@]}" "${RUNTIME[@]}"; do
    has_crd "$plural.$OLD_GROUP" || continue
    while IFS=$'\t' read -r ns name; do
      [[ -z "$name" ]] && continue
      # Nothing serves the old finalizers any more (e.g. corpora-exist on a
      # Connection), so they would hold the delete -- and the CRD -- forever.
      run kubectl -n "$ns" patch "$plural.$OLD_GROUP" "$name" --type=merge -p '{"metadata":{"finalizers":null}}' >/dev/null
    done < <(kubectl get "$plural.$OLD_GROUP" -A -o json | jq -r '.items[] | [.metadata.namespace, .metadata.name] | @tsv')
    run kubectl delete crd "$plural.$OLD_GROUP" --wait=true
  done
}

if [[ "$PHASE" == copy ]]; then
  install_new_crds
  copy_crs
  relabel_stores add
  echo ""
  if $DRY_RUN; then echo "Dry run complete; nothing changed."; exit 0; fi
  echo "✓ Copy done. Upgrade the release now, then run: $0 cleanup"
else
  has_crd "agents.$NEW_GROUP" || { echo "✗ $NEW_GROUP CRDs are not installed; run copy first." >&2; exit 1; }
  copy_crs
  relabel_stores add
  if ! $DRY_RUN; then verify_every_cr_copied; fi
  delete_old
  relabel_stores remove
  echo ""
  if $DRY_RUN; then echo "Dry run complete; nothing changed."; exit 0; fi
  echo "✓ Cleanup done. Only $NEW_GROUP remains."
fi
