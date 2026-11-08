#!/usr/bin/env bash
# pin-image-digests.sh — resolve the long-running Deployments' `:latest`
# images to their current digests and write a Helm values file that pins them.
#
#   scripts/pin-image-digests.sh <out.yaml>
#   helm upgrade ... -f values-production.yaml -f <out.yaml>
#
# Why: production runs `:latest` with `imagePullPolicy: Always`, so the image
# a pod runs is whatever `:latest` is when the pod STARTS, not anything Helm
# recorded. A `helm rollback` then restores the old chart but not the old
# code: the rolled-back pods restart, pull the new `:latest`, and run new code
# on old config. That is how the 433d85a deploy failure became an outage.
# Pinning `tag: latest@sha256:<digest>` puts the digest in the release, so a
# rollback restores the image too, and a new image rolls the Deployment on
# its own.
#
# Digests rather than `:<sha>`: release.yml only rebuilds images whose
# sources changed, so most images have no tag for the commit being deployed.
#
# Reads GHCR anonymously (the packages are public), with curl + jq only,
# since the self-hosted deploy runner may have no docker.

set -euo pipefail

OUT="${1:?usage: pin-image-digests.sh <out.yaml>}"
REGISTRY="${REGISTRY:-ghcr.io}"
PREFIX="${IMAGE_PREFIX:-imaustink/agent-controller}"

# <values key in charts/agent-controller> <image name under PREFIX>
IMAGES=(
  "agent-orchestrator agent-orchestrator"
  "core-controller core-controller"
  "integration-gateway integration-gateway"
)

ACCEPT="application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json"

digest_of() {
  local repo="$1" tag="$2" token digest
  token="$(curl -fsS "https://${REGISTRY}/token?scope=repository:${repo}:pull" | jq -r .token)"
  digest="$(curl -fsSI -H "Authorization: Bearer ${token}" -H "Accept: ${ACCEPT}" \
    "https://${REGISTRY}/v2/${repo}/manifests/${tag}" \
    | tr -d '\r' | awk -F': ' 'tolower($1) == "docker-content-digest" { print $2 }')"
  case "${digest}" in
    sha256:*) echo "${digest}" ;;
    *) echo "could not resolve ${REGISTRY}/${repo}:${tag} to a digest" >&2; return 1 ;;
  esac
}

: > "${OUT}"
for entry in "${IMAGES[@]}"; do
  read -r key image <<<"${entry}"
  digest="$(digest_of "${PREFIX}/${image}" latest)"
  echo "${key}: ${REGISTRY}/${PREFIX}/${image}:latest@${digest}" >&2
  printf '%s:\n  image:\n    tag: "latest@%s"\n' "${key}" "${digest}" >> "${OUT}"
done
