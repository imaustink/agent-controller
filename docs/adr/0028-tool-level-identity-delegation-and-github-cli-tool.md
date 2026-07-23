# 0028. Extend per-user GitHub identity delegation to container Tools, and add a `github` CLI Tool

Date: 2026-07-23

## Status

Accepted

## Context

Issue [imaustink/agent-controller#86](https://github.com/imaustink/agent-controller/issues/86)
asked for "a tool with the GH CLI preinstalled... wired up in prod", using
"the OAuth delegation stuff in the integration gateway to get a token" —
i.e. the same per-user GitHub identity-link mechanism ADR 0022 built for
`opencode-swe-agent`, but for a lighter-weight, non-agentic **Tool** (a
single `gh` command in, `gh`'s own output out) rather than a full coding
sub-agent.

ADR 0022's mechanism, on inspection, was wired exclusively through
`Agent`/`AgentRun`:

- `ToolRunSpec` (`controllers/core-controller/api/v1alpha1/toolrun_types.go`)
  had no `secretEnv` field at all — only `toolRef`/`args`/`callback`/
  `timeoutSeconds` — unlike `AgentRunSpec`, which gained `SecretEnv
  []SecretEnvVar` under ADR 0022. There was nothing for the Go reconciler's
  `mergeSecretEnv` (already generic, `run_job.go`) to merge for a ToolRun.
- `ToolSpec` had no `IdentityProviders` field, unlike `AgentSpec`.
- `ContainerToolLauncher`/`LaunchOptions` (`k8s/container-tool-launcher.ts`)
  and `ToolRunLauncher` (`k8s/toolrun-launcher.ts`) had no `secretEnv` option
  or Secret-creation logic at all, unlike `AgentLaunchOptions`/
  `AgentRunLauncher`.
- `graph.ts`'s `runTool` only checked `tool.identityProviders` inside the
  `tool.agentRunTemplate` branch (an agent-backed Tool dispatched as an
  AgentRun, ADR 0021) — the `tool.jobTemplate` branch (a genuine container
  Tool/Job) had no identity gate at all.

So a real container Tool authenticating as the calling user's own GitHub
identity, rather than a shared bot/PAT baked into its Secret, required new
plumbing at every layer ADR 0022 already built for Agents — not a
reimplementation, but the same mechanism extended one CRD kind further.

## Decision

1. **`ToolRunSpec` gains `SecretEnv []SecretEnvVar`**, identical in shape and
   semantics to `AgentRunSpec.SecretEnv` — a per-invocation override/addition
   to the referenced `Tool`'s static `secretEnv`, keyed by env var name.
   `ToolRunReconciler.buildJob` now calls the already-generic
   `mergeSecretEnv(tool.Spec.SecretEnv, run.Spec.SecretEnv)` (previously it
   passed `tool.Spec.SecretEnv` straight through) — no change needed to
   `mergeSecretEnv` itself, since it never assumed a specific CRD kind.
2. **`ToolSpec` gains `IdentityProviders []string`**, mirroring
   `AgentSpec.IdentityProviders` — the source-of-truth declaration, on the
   catalog entry, of which external identity a caller must have linked
   before this Tool can be launched. Only meaningful for a container Tool;
   an agent-backed Tool continues to carry this on the wrapped `Agent` CR
   instead (ADR 0021's existing `agentRefs`-resolution path is unchanged).
3. **`ToolRunLauncher` (TypeScript) gains the same per-invocation identity
   `secretEnv` mechanism `AgentRunLauncher` already had**: given
   `LaunchOptions.secretEnv`, it creates a dedicated `${name}-identity` k8s
   Secret via a new optional `SecretApiLike` constructor param (a `CoreV1Api`
   slice, shared type with `AgentRunLauncher`), references it from
   `ToolRunSpec.secretEnv`, and patches the Secret's `ownerReferences` to the
   created `ToolRun` for GC — byte-for-byte the same pattern, so the two
   launchers stay structurally identical.
4. **`CrdToolRegistry` reads `Tool.spec.identityProviders` onto
   `ToolDescriptor.identityProviders`** for a container Tool (previously this
   field was only ever populated for an agent-backed Tool via
   `AgentDescriptor.identityProviders`).
5. **`graph.ts`'s `runTool` gates the `tool.jobTemplate` branch on
   `tool.identityProviders`**, exactly mirroring the existing gate in the
   `tool.agentRunTemplate` branch and in `delegateToAgent`: resolve the
   caller's linked token via `deps.identityLinkGateway.getToken`, map the
   provider to an env var name via the existing `PROVIDER_ENV_VAR` table
   (`{ github: "GITHUB_TOKEN" }`), and pass it through
   `containerToolLauncher.launch()`'s `options.secretEnv`. Same v1 scope cut
   as the agent-backed-tool branch: this path never *starts* a fresh
   device-flow/authcode link (no session slot analogous to
   `pendingIdentityLink` exists for a paused tool call) — a caller links once
   via a direct conversation with an identity-linking-capable Agent (e.g.
   `opencode-swe-agent`) before a Skill can route them to an identity-gated
   Tool.
6. **New `github` Tool (`tools/github/`)**: a `recipe-publisher`/
   `kubectl-readonly`-shaped container — `gh` CLI preinstalled (pinned
   release binary + sha256 checksum verification, same pattern as
   `kubectl-readonly`'s pinned `kubectl`), a single command line in
   (`argv[2]`), `gh`'s own stdout out over the standard messaging protocol.
   An explicit top-level-command allowlist (`src/allowlist.ts`) blocks
   `auth`/`api`/`config`/`secret`/`ssh-key`/etc. entirely and a handful of
   individually irreversible-ish subcommands (`repo delete`, `issue
   delete`/`transfer`, `workflow run`, ...) even within an allowed command —
   but, unlike `kubectl-readonly`, does **not** additionally restrict flags/
   values, since (unlike `kubectl-readonly`'s fixed cluster-wide
   ServiceAccount) this tool's real authorization boundary is the delegated
   human's own GitHub permissions on whatever they target, the same posture
   `opencode-swe-agent` already has (ADR 0022, `docs/security.md`).
7. **Helm wiring** (`charts/community-components`): new
   `templates/tool-github.yaml` (a `Tool` CR, `identityProviders: [github]`
   when `githubTool.identityLink.enabled`, a static `GITHUB_TOKEN` secretEnv
   otherwise — same `if not identityLink.enabled` branching as
   `agent-opencode-swe.yaml`) and `templates/serviceaccount-github.yaml`
   (plain ServiceAccount, mirrors `serviceaccount-web-fetch.yaml`). No
   changes needed to `charts/agent-controller` (the orchestrator/gateway
   identity-link plumbing — `IDENTITY_LINK_GATEWAY_URL/TOKEN`,
   `GATEWAY_IDENTITY_LINK_TOKEN`, the orchestrator's `secrets: create/patch`
   RBAC — is already provider/CR-kind-agnostic and shared by any Agent or,
   after this decision, Tool that declares `identityProviders`).
   `values-production.yaml` enables `githubTool` with
   `identityLink.enabled: true`, reusing the identity-link gateway already
   turned on for `opencodeSweAgent` — no new gateway/App configuration
   required.

## Consequences

- Any container Tool can now opt into per-user GitHub identity delegation by
  declaring `identityProviders` on its `Tool` CR — this is a generic CRD/
  reconciler/launcher extension, not something specific to the `github`
  Tool. A future Tool needing the same pattern (or a different provider,
  once `PROVIDER_ENV_VAR` gains more entries) needs no further plumbing
  changes.
- `ToolRunSpec` and `AgentRunSpec` now carry structurally identical
  `SecretEnv` fields and the two TS launchers share the same
  `SecretApiLike` shape — reduces the temptation for the two to drift, at
  the cost of a small duplication between `agentrun-launcher.ts` and
  `toolrun-launcher.ts` (a shared helper was considered but deferred: the
  two CR kinds' `spec` shapes differ enough — `agentRef`+`goal` vs.
  `toolRef`+`args` — that factoring out just the Secret-creation half would
  add an extra indirection for a relatively small amount of shared code).
- The `github` Tool's blast radius, like `opencode-swe-agent`'s, is bounded
  by the linked human's own GitHub permissions rather than a shared
  bot/PAT's fixed scope — a caller can only do what they could already do on
  GitHub directly. The command allowlist is defense-in-depth clarity about
  this tool's intended purpose, not the primary authorization boundary.
- A caller who hasn't linked GitHub yet gets a clear, actionable error from
  this Tool's call path rather than a silent credential-less failure or (the
  ADR 0022-era gap this closes) a Tool that could only ever run with a
  shared static token.
