import { createHash } from "node:crypto";

/**
 * The `MCPServer` and `MCPTool` custom resources, mirroring
 * `orchestrator/controllers/core-controller/api/v1alpha1/mcpserver_types.go` and
 * `mcptool_types.go`. Only the fields the BROKER reads or writes are declared.
 *
 * `MCPServer` is operator-authored desired state; `MCPTool` is derived state
 * the broker WRITES (ADR 0045 §1). The split is the whole point — the exposure
 * map on the server is the operator's permission grant, and the materialized
 * tool is machine output gated by it — so this module keeps the two shapes and
 * the rules that turn one into the other in one place.
 */

/** A Secret key reference, as on every CR that carries `secretEnv`. */
export interface SecretKeySelector {
  name: string;
  key: string;
}

export interface SecretEnvVar {
  name: string;
  secretRef: SecretKeySelector;
}

/**
 * One entry in `MCPServer.spec.exposure`: the operator's decision to expose a
 * remote tool, and with which roles (ADR 0045 §4). Default-DENY — a remote tool
 * is callable only because an entry names it.
 */
export interface MCPToolExposure {
  remoteToolName: string;
  /** Defaults to true (matches the CRD's `+kubebuilder:default=true`). */
  expose?: boolean;
  allowedRoles: string[];
  /**
   * Overrides the materialized MCPTool's metadata.name. Used VERBATIM (see
   * {@link catalogIdFor}) — the broker never sanitizes it, because a silent
   * rename would break the id a Skill references in toolRefs. The CRD enforces a
   * valid DNS-1123 name on this field, so the apiserver rejects a bad value at
   * write time rather than the broker failing to materialize the tool.
   */
  toolID?: string;
  hidden?: boolean;
  tier?: string;
  /**
   * Tool-approval policy (ADR 0003) carried onto the materialized MCPTool's
   * `approval` — "never" | "always" | "auto". Mirrors `tier`: the operator's
   * decision on the exposure entry, copied verbatim into the derived MCPTool.
   */
  approval?: string;
}

export interface MCPServerSpec {
  transport: string;
  url: string;
  displayName?: string;
  /** The DISCOVERY (service) credential, for tools/list. Separate from invocation. */
  secretEnv?: SecretEnvVar[];
  /** When non-empty, invocation requires a per-user delegated token (ADR 0045 §5). */
  identityProviders?: string[];
  exposure?: MCPToolExposure[];
}

export interface MCPDiscoveredTool {
  name: string;
  description?: string;
  /** The tool's JSON Schema, serialized as a JSON string (matches the CRD). */
  inputSchema?: string;
  exposed?: boolean;
}

export interface MCPServerStatus {
  discoveredTools?: MCPDiscoveredTool[];
  exposedTools?: number;
  observedGeneration?: number;
  conditions?: K8sCondition[];
}

export interface MCPServerCustomResource {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    uid?: string;
    generation?: number;
  };
  spec: MCPServerSpec;
  status?: MCPServerStatus;
}

/** The `metav1.Condition` shape, as the CRDs use it. */
export interface K8sCondition {
  type: string;
  status: "True" | "False" | "Unknown";
  reason: string;
  message: string;
  lastTransitionTime: string;
  observedGeneration?: number;
}

/** The spec of a derived `MCPTool` (ADR 0045 §2 — the `mcpExec` catalog record). */
export interface MCPToolSpec {
  serverRef: string;
  remoteToolName: string;
  description: string;
  inputSchema?: string;
  allowedRoles: string[];
  hidden?: boolean;
  tier?: string;
  /** Tool-approval policy (ADR 0003), copied from the exposure entry — mirrors `tier`. */
  approval?: string;
  identityProviders?: string[];
}

export interface MCPToolCustomResource {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    namespace?: string;
    labels?: Record<string, string>;
    ownerReferences?: OwnerReference[];
  };
  spec: MCPToolSpec;
}

export interface OwnerReference {
  apiVersion: string;
  kind: string;
  name: string;
  uid: string;
  controller?: boolean;
  blockOwnerDeletion?: boolean;
}

export const GROUP = "core.controller-agent.dev";
export const VERSION = "v1alpha1";
export const MCPSERVER_PLURAL = "mcpservers";
export const MCPTOOL_PLURAL = "mcptools";
export const MCPSERVER_KIND = "MCPServer";
export const MCPTOOL_KIND = "MCPTool";

/** Label stamped on every derived MCPTool, so a server's tools can be listed. */
export const SERVER_LABEL = "mcpserver.core.controller-agent.dev/name";

/**
 * Whether an exposure entry currently materializes its tool.
 *
 * `expose` defaults TRUE (the CRD default): an entry that merely names a tool
 * exposes it. `expose: false` keeps the entry — and its role assignment — on
 * record while withdrawing the tool from the catalog.
 */
export function isExposed(entry: MCPToolExposure): boolean {
  return entry.expose !== false;
}

/**
 * The exposure map keyed by remote tool name.
 *
 * `+listMapKey=remoteToolName` on the CRD means a server cannot carry two
 * entries for one tool, so a plain last-wins map is faithful to the API.
 */
export function exposureByRemoteName(
  server: MCPServerCustomResource,
): Map<string, MCPToolExposure> {
  const map = new Map<string, MCPToolExposure>();
  for (const entry of server.spec.exposure ?? []) {
    if (entry?.remoteToolName) map.set(entry.remoteToolName, entry);
  }
  return map;
}

const MAX_K8S_NAME = 253;

/**
 * The catalog id (metadata.name) of the MCPTool materialized for one exposure.
 *
 * `toolID` wins when the operator set one, giving a stable, friendly id they
 * control. Otherwise it is a deterministic `mcp-<server>-<remoteTool>`,
 * sanitized to a legal k8s name — so the same (server, tool) always maps to the
 * same object and discovery updates rather than duplicates it.
 */
export function catalogIdFor(
  server: string,
  entry: MCPToolExposure,
): string {
  if (entry.toolID && entry.toolID.trim()) return entry.toolID.trim();

  const base = sanitizeName(`mcp-${server}-${entry.remoteToolName}`);
  // sanitizeName is not injective — it collapses case, underscores and other
  // characters to `-`, so two distinct remote tool names on ONE server (e.g.
  // `get_user` and `get-user`, or `getUser` and `get-user`) can sanitize to the
  // same id. Both would then land in discovery's `desired` with one catalogId;
  // reconcile creates the first and the second 409s into a swallowed onError, so
  // an exposed tool silently never materializes. snake_case is common in MCP
  // tool naming, so this is reachable. When sanitizing the remote tool name was
  // lossy, disambiguate with a short deterministic hash of the ORIGINAL name:
  // distinct names get distinct ids, while a name already a clean k8s segment
  // stays readable (no suffix).
  if (sanitizeName(entry.remoteToolName) !== entry.remoteToolName) {
    const hash = createHash("sha1").update(entry.remoteToolName).digest("hex").slice(0, 8);
    const suffix = `-${hash}`;
    return `${base.slice(0, MAX_K8S_NAME - suffix.length).replace(/-+$/g, "")}${suffix}`;
  }
  return base;
}

/**
 * Coerces an arbitrary string into a legal k8s object name: lowercase, only
 * `[a-z0-9-]`, no leading/trailing or doubled separators.
 *
 * A remote tool name is the SERVER's to choose, so it can contain anything —
 * underscores, slashes, capitals, unicode — all of which collapse to `-`. The
 * result stays readable (`mcp-github-search-issues`). Only when the name does
 * not fit a k8s object name — over the length limit, or sanitized to nothing —
 * is a short hash of the ORIGINAL appended, truncating the base to make room,
 * so an over-long or exotic name still gets a stable, unique, legal id.
 */
export function sanitizeName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (cleaned !== "" && cleaned.length <= MAX_K8S_NAME) return cleaned;

  const hash = createHash("sha1").update(raw).digest("hex").slice(0, 8);
  const suffix = `-${hash}`;
  const base = (cleaned || "mcp").slice(0, MAX_K8S_NAME - suffix.length).replace(/-+$/g, "");
  return `${base}${suffix}`;
}
