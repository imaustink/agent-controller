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
   * Job launch template (container tools, ADR 0010). Set for tools launched
   * as k8s Jobs; absent for LocalTools (which set `localExec` instead).
   */
  jobTemplate?: JobTemplate;
  /**
   * Local execution spec (LocalTools, ADR 0014). Set for tools run in-pod by
   * an executor sidecar; absent for container/Job tools. Exactly one of
   * `jobTemplate` / `localExec` is present.
   */
  localExec?: LocalToolSpec;
  /** Optional coarse risk/cost tier, for future quota/authorization use. */
  tier?: string;
}
