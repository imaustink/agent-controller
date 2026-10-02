import type { AgentRunTemplate } from "./agents/types.js";
import type { CallerToolDescriptor } from "./caller-tools/types.js";
import type { KnowledgeBaseExecSpec } from "./knowledge-base/exec.js";

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
 * Everything dispatching an MCP tool needs: which server to reach and which
 * remote tool to call. Mirrors the Go `MCPExecSpec`
 * (`engines/temporal/internal/catalog/descriptors.go`, ADR 0045) and the
 * dispatch-relevant fields of `MCPToolSpec`
 * (`controllers/core-controller/api/v1alpha1/mcptool_types.go`).
 *
 * The mcp-broker holds the MCP session; this carries only what the proxy call
 * needs. The caller's delegated token is resolved from
 * {@link ToolDescriptor.identityProviders} at dispatch and never rides this
 * descriptor.
 */
export interface MCPExecSpec {
  serverRef: string;
  remoteToolName: string;
  /** The remote tool's raw JSON Schema, carried verbatim from discovery; empty when the server advertised none. */
  inputSchema?: string;
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
   * Keeps a tool REFERENCEABLE but not RETRIEVABLE: `getByIds` finds it,
   * semantic `query` never returns it.
   *
   * For tools that exist only to be named by something else. A knowledge
   * base's generated search tool, and a Connection's scoped GET tool, are
   * reachable precisely because the knowledge base that declares them was
   * selected (docs/adr/0039 §2). Letting them compete in open retrieval would
   * put every client's scoped tooling in front of every caller, which is the
   * outcome that design exists to prevent.
   */
  hidden?: boolean;
  /**
   * Set when this descriptor was DERIVED from a KnowledgeBase (docs/adr/0039)
   * rather than authored as a CR. Like `localExec` it selects a dispatch path —
   * here, retrieval in-process rather than any kind of launch — and carries
   * what that path needs.
   */
  knowledgeBaseExec?: KnowledgeBaseExecSpec;
  /**
   * A Corpus's live GET face (docs/adr/0038 §5), and what dispatching it needs.
   *
   * Present or the tool is not generated at all. A catalog entry with no way
   * to run it is worse than a missing one: the planner can pick it, and the
   * turn fails after the model has already committed to an approach.
   *
   * PARITY: `CorpusGetExecSpec` in `engines/temporal/internal/catalog`.
   */
  corpusGetExec?: {
    corpusId: string;
    label?: string;
    identityProviders?: string[];
  };
  /**
   * Job launch template (container tools, ADR 0010). Set for tools launched
   * as k8s Jobs; absent for LocalTools/agent-backed tools.
   */
  jobTemplate?: JobTemplate;
  /**
   * Local execution spec (LocalTools, ADR 0014). Set for tools run in-pod by
   * an executor sidecar; absent otherwise. Exactly one of `jobTemplate` /
   * `localExec` / `agentRunTemplate` / `callerTool` / `mcpExec` is present.
   */
  localExec?: LocalToolSpec;
  /**
   * MCP proxy spec (MCPTools, ADR 0045) — set when this descriptor was derived
   * from an `MCPTool` CR, the broker-written catalog form of one exposed Model
   * Context Protocol tool. Like `localExec`/`agentRunTemplate` it is the marker
   * that selects a dispatch path — here, one `tools/call` relayed through the
   * mcp-broker under the caller's own delegated token. The engine never speaks
   * MCP. The `identityProviders` the broker presents are resolved from the
   * top-level {@link ToolDescriptor.identityProviders} at dispatch, exactly as a
   * container Tool's are, not baked in here.
   */
  mcpExec?: MCPExecSpec;
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
   * user's own linked GitHub token rather than a shared credential. For an
   * `mcpExec` tool, populated from `MCPTool.spec.identityProviders` and resolved
   * into the caller's delegated token the mcp-broker presents on `tools/call`
   * (ADR 0045 §5, fail-closed). Absent for LocalTools and for tools with no
   * identity requirement.
   */
  identityProviders?: string[];
  /** Optional coarse risk/cost tier, for future quota/authorization use. */
  tier?: string;
}
