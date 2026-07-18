import * as k8s from "@kubernetes/client-node";
import type { CatalogEntry, CatalogRegistry } from "./types.js";

/** Shape of a `Tool` custom resource (`<group>/<version>`, kind `Tool`). */
export interface ToolCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    input: string;
    output: string;
    allowedRoles: string[];
    tier?: string;
    agentRef?: string;
    image?: string;
    serviceAccountName?: string;
    args?: string[];
    env?: { name: string; value: string }[];
    resources?: {
      requests?: Record<string, string>;
      limits?: Record<string, string>;
    };
  };
}

/** Shape of an `Agent` custom resource (`<group>/<version>`, kind `Agent`). */
export interface AgentCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    input: string;
    output: string;
    allowedRoles: string[];
    tier?: string;
    orchestratorPrompt?: string;
  };
}

/** Minimal slice of the k8s CustomObjectsApi needed by this registry. */
export interface CustomObjectsApiLike {
  getNamespacedCustomObject(request: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
}

export const TOOL_PLURAL = "tools";
export const AGENT_PLURAL = "agents";

/**
 * Direct id lookup against Tool/Agent custom resources for the phase-1 gateway.
 * This skips RAG entirely: `POST /fn/:id` already names the catalog entry.
 */
export class CrdCatalogRegistry implements CatalogRegistry {
  constructor(
    private readonly namespace: string,
    private readonly group: string,
    private readonly version: string,
    private readonly api: CustomObjectsApiLike,
  ) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdCatalogRegistry {
    return new CrdCatalogRegistry(namespace, group, version, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async getById(id: string): Promise<CatalogEntry | undefined> {
    const tool = await this.tryGet(TOOL_PLURAL, id);
    if (tool) {
      const entry = toToolEntry(tool as ToolCustomResource, this.namespace);
      if (entry) return entry;
    }

    const agent = await this.tryGet(AGENT_PLURAL, id);
    if (agent) {
      const entry = toAgentEntry(agent as AgentCustomResource, this.namespace);
      if (entry) return entry;
    }

    return undefined;
  }

  private async tryGet(plural: string, name: string): Promise<unknown | undefined> {
    try {
      return await this.api.getNamespacedCustomObject({
        group: this.group,
        version: this.version,
        namespace: this.namespace,
        plural,
        name,
      });
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }
}

function toToolEntry(cr: ToolCustomResource, namespace: string): CatalogEntry | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec) return undefined;

  if (spec.agentRef) {
    return {
      kind: "tool",
      id: name,
      allowedRoles: spec.allowedRoles ?? [],
      agentRunTemplate: { namespace, agentRef: spec.agentRef },
    };
  }

  if (!spec.image || !spec.serviceAccountName) return undefined;

  return {
    kind: "tool",
    id: name,
    allowedRoles: spec.allowedRoles ?? [],
    jobTemplate: {
      image: spec.image,
      namespace,
      serviceAccountName: spec.serviceAccountName,
      args: spec.args,
      env: Object.fromEntries((spec.env ?? []).map((entry) => [entry.name, entry.value])),
      resources: spec.resources
        ? {
            requests: { cpu: spec.resources.requests?.cpu, memory: spec.resources.requests?.memory },
            limits: { cpu: spec.resources.limits?.cpu, memory: spec.resources.limits?.memory },
          }
        : undefined,
      toolRef: name,
    },
  };
}

function toAgentEntry(cr: AgentCustomResource, namespace: string): CatalogEntry | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.description) return undefined;

  return {
    kind: "agent",
    id: name,
    allowedRoles: spec.allowedRoles ?? [],
    agentRunTemplate: { namespace, agentRef: name },
  };
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const statusCode = "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
  if (statusCode === 404) return true;
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (code === 404 || code === "404") return true;
  const body = "body" in error ? (error as { body?: unknown }).body : undefined;
  if (typeof body === "object" && body !== null) {
    const bodyCode = "code" in body ? (body as { code?: unknown }).code : undefined;
    if (bodyCode === 404 || bodyCode === "404") return true;
  }
  return false;
}
