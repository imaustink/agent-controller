# syntax=docker/dockerfile:1

# Per-language LocalTool executor sidecar (ADR 0013). ONE image per runtime,
# selected at build time via BASE_IMAGE + RUNTIME. The executor logic is a
# single static Go binary copied into each runtime's base image (which supplies
# that language's toolchain: npm/pip/go/sh). bubblewrap provides the
# per-invocation sandbox (namespaces, read-only fs, cleared env).
#
# Build all four (from this directory):
#   docker build --build-arg BASE_IMAGE=node:24-bookworm-slim   --build-arg RUNTIME=node   -t localtool-executor-node:latest   .
#   docker build --build-arg BASE_IMAGE=python:3.12-slim-bookworm --build-arg RUNTIME=python -t localtool-executor-python:latest .
#   docker build --build-arg BASE_IMAGE=golang:1.24-bookworm    --build-arg RUNTIME=go     -t localtool-executor-go:latest     .
#   docker build --build-arg BASE_IMAGE=debian:bookworm-slim    --build-arg RUNTIME=shell  -t localtool-executor-shell:latest  .

ARG BASE_IMAGE=debian:bookworm-slim

FROM golang:1.24-bookworm AS build
WORKDIR /src
COPY go.mod ./
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -o /out/localtool-executor ./cmd/localtool-executor

FROM ${BASE_IMAGE} AS runtime
ARG RUNTIME
ENV LOCALTOOL_RUNTIME=${RUNTIME}
ENV LOCALTOOL_SOCKET_DIR=/run/localtool
ENV LOCALTOOL_CACHE_DIR=/var/cache/localtool
# bubblewrap: per-invocation sandbox. curl/jq/ca-certificates: for shell tools +
# TLS trust. Installed on every runtime image for uniformity (small footprint).
RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap ca-certificates curl jq \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /out/localtool-executor /usr/local/bin/localtool-executor
# Non-root, mirroring the orchestrator's hardened posture. The socket dir and
# cache dir are writable volumes provided by the Helm chart.
RUN useradd -u 10001 -m executor \
 && mkdir -p /run/localtool /var/cache/localtool \
 && chown -R 10001:10001 /run/localtool /var/cache/localtool
USER 10001
ENTRYPOINT ["/usr/local/bin/localtool-executor"]
