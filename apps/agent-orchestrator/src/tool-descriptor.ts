import type { AgentRunTemplate } from "./agents/types.js";
import type { CallerToolDescriptor } from "./caller-tools/types.js";

/**
 * k8s Job template needed to run a tool/sub-agent — everything the launcher
 * needs beyond the per-call args/env (see docs/orchestrator.md#4-container-tool-launcher).
 */
export interface JobTemplate {
  image: string;
  namespace: string;
  serviceAccountName: string;
  args?: string[];
  env?: Record<string, string>;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /**
   * Name of the Tool custom resource this template was resolved from (ADR
   * 0010). Only populated by `CrdToolRegistry` — required by
   * `ToolRunLauncher` (which creates a ToolRun CR referencing a Tool by
   * name, rather than embedding image/serviceAccount directly into a Job
   * itself).
   */
  toolRef?: string;
}

/**
 * Reference to a Secret key in the tool's namespace, mirroring the CRD's
 * `SecretEnvVar`. The ORCHESTRATOR resolves these (it holds the k8s identity;
 * the executor sidecars deliberately do not) and passes the resolved plaintext
 * to the sidecar over the pod-local unix socket (ADR 0014).
 */
export interface LocalSecretEnvVar {
  name: string;
  secretRef: { name: string; key: string };
}

/**
 * Everything the LocalTool executor sidecar needs to fetch and run a tool
 * (ADR 0014). A `LocalTool` CR is executed in-pod by a per-language executor
 * sidecar instead of being launched as a k8s Job — so this is the local
 * counterpart of {@link JobTemplate}. Exactly one of `jobTemplate` /
 * `localExec` is set on a {@link ToolDescriptor}.
 */
export interface LocalToolSpec {
  /** Which executor sidecar runs this tool. */
  runtime: "node" | "python" | "go" | "shell";
  /** Registry package coordinate (npm/PyPI name, or Go module path). Absent for shell. */
  package?: string;
  /** Exact pinned version. Absent for shell. */
  version?: string;
  /** Module/console-script/binary within the package, when non-default. */
  entry?: string;
  /** Pinned https:// script location (shell runtime). */
  sourceUrl?: string;
  /** Lowercase hex sha256 digest verified before execution. Required for shell. */
  checksum?: string;
  /** Static, non-secret env vars passed to the tool. */
  env?: Record<string, string>;
  /** Secret-backed env vars, resolved by the orchestrator at exec time. */
  secretEnv?: LocalSecretEnvVar[];
  /** Whether the tool is allowed egress (default false — sidecar unshares the netns). */
  network: boolean;
  /** Per-execution timeout; falls back to the orchestrator default when unset. */
  timeoutSeconds?: number;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
}

/**
 * A single tool or sub-agent that can be launched as a k8s Job. This is what
 * gets embedded/upserted into the RAG index (see ADR 0003/0004).
 */
export interface ToolDescriptor {
  /** Stable identifier; also used as the vector-store point id. */
  id: string;
  name: string;
  /** Natural-language description — this is the text that gets embedded. */
  description: string;
  /** Roles/scopes allowed to invoke this tool; enforced as a retrieval filter (ADR 0004). */
  allowedRoles: string[];
  /**
   * ABAC private-scoping (docs/adr/0037): when non-empty, this tool is PRIVATE
   * — only a caller whose resolved principal is in this list may retrieve/use
   * it, layered ON TOP of {@link allowedRoles}. Absent/empty means no ABAC
   * restriction (RBAC-only, today's behavior). Mirrors
   * `Tool.spec.allowedPrincipals` / `LocalTool.spec.allowedPrincipals`.
   */
  allowedPrincipals?: string[];
  /**
   * Job launch template (container tools, ADR 0010). Set for tools launched
   * as k8s Jobs; absent for LocalTools/agent-backed tools.
   */
  jobTemplate?: JobTemplate;
  /**
   * Local execution spec (LocalTools, ADR 0014). Set for tools run in-pod by
   * an executor sidecar; absent otherwise. Exactly one of `jobTemplate` /
   * `localExec` / `agentRunTemplate` / `callerTool` is present.
   */
  localExec?: LocalToolSpec;
  /**
   * Agent-backed tool template (`Tool.spec.agentRef`) — set when this Tool
   * wraps an `Agent` CR instead of launching its own container/Job. The
   * orchestrator dispatches a call to this tool as an `AgentRun` against the
   * referenced Agent (same mechanism the peer-level Agent-delegation path
   * uses), letting a Skill's `toolRefs` reach a full agent loop (e.g. a
   * coding agent that opens PRs) without the Skill/Agent catalogs needing to
   * merge. Absent for container/LocalTools.
   */
  agentRunTemplate?: AgentRunTemplate;
  /**
   * Caller-supplied function definition (docs/adr/0035) — set when this tool
   * came from the request body's `tools` array rather than from a `Tool`/
   * `LocalTool` CR. The fourth mutually-exclusive dispatch kind, and the only
   * one the orchestrator does NOT execute: `runTool` hands the call back to the
   * caller as `tool_calls` and ends the turn, because the caller's own client
   * runs the function. Ids in this namespace are prefixed `caller:` so they can
   * never collide with or shadow a catalog tool id.
   */
  callerTool?: CallerToolDescriptor;
  /**
   * External identity providers the CALLING user must have linked (ADR
   * 0022/0027) before this tool can be launched. For an agent-backed tool,
   * carried over from `AgentDescriptor.identityProviders` when a Skill's
   * `agentRefs` resolves an Agent into a ToolDescriptor (`loadSkillTools`).
   * For a container Tool, populated directly from `Tool.spec.identityProviders`
   * (`CrdToolRegistry`) -- e.g. the `github` Tool, which needs the calling
   * user's own linked GitHub token rather than a shared credential. Absent
   * for LocalTools and for tools with no identity requirement.
   */
  identityProviders?: string[];
  /** Optional coarse risk/cost tier, for future quota/authorization use. */
  tier?: string;
}
