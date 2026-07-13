# 0014. LocalTool: multi-runtime sandboxed in-pod tool execution

Date: 2026-07-12

## Status

Accepted

## Context

Every tool so far (ADR 0001, 0010) runs as a one-shot k8s Job launched by the
tool-controller: a `Tool` CR points at a prebuilt container image, a `ToolRun`
CR is created per invocation, the controller builds a hardened Job, and the
tool reports back over the HMAC callback protocol. That gives strong isolation
(a fresh pod per call, its own image, ServiceAccount, network identity) but
pays k8s **scheduling latency** on every call — image pull, pod admission,
kubelet start — which is wasteful for small, fast tools.

We want a lower-latency execution path for lightweight tools, explicitly
**trading some isolation for speed**, while keeping the system as locked down
as practical. Additional requirements that emerged while designing it:

- Tools should not be limited to one language: **node, python, go, and shell**
  must all be supported.
- Tool code should be **packaged and pulled from the relevant registry**
  (npm / PyPI / Go module proxy; a pinned URL for shell) at runtime and cached,
  rather than baked into an image ahead of time.
- Filesystem access should be restricted and each tool run under limited
  permissions.

A first design ran tools as sandboxed child processes inside the orchestrator
itself. That was rejected: it would force every language toolchain into the
orchestrator image, and — worse — the **install step itself executes untrusted
code** (`npm` postinstall, `pip` builds, `go` compilation), which would run in
the orchestrator's own process/pod with its secrets and k8s identity in reach.

## Decision

Introduce a distinct **`LocalTool`** CRD and a **per-language executor sidecar**
that runs in the orchestrator pod. This is the middle ground between an
in-orchestrator child process (fastest, least isolated) and a k8s Job (most
isolated, slowest): in-pod execution keeps latency low (no scheduling, warm
runtime, shared cache) while a separate container restores real
container-level isolation.

1. **`LocalTool` CRD** (`controllers/tool-controller/api/v1alpha1/localtool_types.go`).
   Catalog/RAG fields like `Tool` (`description`/`input`/`output`/`allowedRoles`/
   `tier`) plus a `runtime` enum, a pinned package coordinate
   (`package`+exact `version`+optional `entry`, or `sourceURL`+`checksum` for
   shell), `env`/`secretEnv`, a `network` opt-in flag, `timeoutSeconds`, and
   `resources`. A minimal reconciler validates the cross-field packaging
   constraints and sets a `Ready` condition; it never builds a Job.

2. **Language-agnostic stdio ABI.** A tool reads its input (a string/JSON) on
   **stdin** and writes exactly one final JSON envelope to **stdout**
   (`{"type":"succeeded","result":…}` or `{"type":"failed","code","message"}`);
   exit 0 = success. This replaces the earlier idea of a TypeScript module
   interface — it works identically for every runtime, and any language just
   needs to read stdin and print one line.

3. **Executor sidecars** (`sidecars/localtool-executor/`, one Go binary,
   `LOCALTOOL_RUNTIME` selects behavior, one image per runtime). Each listens on
   a **unix socket** on a shared `emptyDir` (`POST /run`, HTTP-over-unix-socket
   — off the network entirely). It fetches+caches the pinned package (with
   integrity guardrails, below), then runs it under a **per-invocation
   bubblewrap sandbox**: new user/ipc/uts/cgroup namespaces (plus a new,
   interface-less **network namespace** unless the tool set `network: true`),
   `--clearenv` + explicit `--setenv` (the tool sees only its declared env +
   a default HOME/PATH), read-only root + tmpfs `/tmp`, and a wall-clock
   timeout. It deliberately does **not** unshare the PID namespace: that would
   force mounting a fresh `/proc`, which a container runtime's masked `/proc`
   makes the kernel reject — so the bound `/proc` is reused instead.

4. **Orchestrator integration** (`apps/agent-orchestrator/src/local/`). A
   `CrdLocalToolRegistry` reads `LocalTool` CRs into `ToolDescriptor`s carrying a
   `localExec` spec (instead of a `jobTemplate`); both catalogs are unioned into
   the same RAG index, so skills reference either kind transparently by CR name.
   The graph's `launchJob` node branches: a `localExec` tool goes to
   `LocalToolExecutor.run()`, which resolves `secretEnv` from k8s Secrets, POSTs
   the run request to the matching sidecar's socket, and maps the returned
   envelope onto the same messaging `Event` the Job path produces.

5. **No k8s identity for sidecars.** The pod sets
   `automountServiceAccountToken: false` and projects the ServiceAccount token
   **only** into the orchestrator container. Sidecars therefore cannot reach the
   k8s API. Secret resolution stays in the orchestrator (which holds the token);
   resolved values travel to the sidecar only over the pod-local unix socket.

6. **Integrity + install-time containment.** Exact version pinning (ranges/tags
   rejected fail-closed), sha256 checksum verification (required for shell), a
   registry-host allowlist, and install-time script suppression where possible
   (`npm --ignore-scripts`, `pip --only-binary=:all:`). The fetch/install phase
   — itself untrusted code execution — is confined to the sidecar's own
   container, separate from the orchestrator.

## Consequences

- **Latency drops** for small tools: no Job scheduling, warm runtimes, cached
  packages. First use of a package pays a fetch; subsequent calls are warm.
- **Isolation is weaker than a Job**: sidecars share the pod (same node, same
  kernel, and — critically — the **same network namespace**). A k8s
  `NetworkPolicy` is pod-level and cannot distinguish sidecar from orchestrator,
  so per-tool egress control is provided by the sidecar's own bwrap network
  namespace, **not** by NetworkPolicy.
- **New hard prerequisites**: bubblewrap's per-invocation namespaces need
  **unprivileged user namespaces enabled on the node** AND the sidecar running
  with **`seccompProfile: Unconfined`** — the `RuntimeDefault` profile filters
  the namespace-creation `clone`/`unshare` flags once all capabilities are
  dropped, so bwrap fails with "No permissions to create new namespace". The
  sidecar otherwise stays hardened (non-root, cap-drop ALL, read-only rootfs)
  and has no k8s identity. Where userns is unavailable the sandbox fails closed
  (the run fails) — documented in `docs/security.md`.
- **Executing registry code inside the orchestrator pod is a real posture
  shift** for this repo. Creating a `LocalTool` CR is therefore a privileged
  operation (arbitrary third-party code execution) and must be gated by k8s RBAC.
  The orchestrator also gains `secrets: get` when LocalTools are enabled, a
  deliberate blast-radius increase.
- **Always-on cost**: each enabled runtime is a resident sidecar container. The
  chart lets operators trim `localTool.runtimes` to only the languages they use,
  and defaults the whole feature to disabled.
- The container/Job path (ADR 0010) remains the right choice for heavier or less
  trusted tools; LocalTools are an additive option, not a replacement.
