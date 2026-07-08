import * as k8s from "@kubernetes/client-node";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { ToolRegistry } from "./types.js";

/** Shape of a `Tool` custom resource (`<group>/<version>`, kind `Tool`) — mirrors
 * `controllers/tool-controller/api/v1alpha1/tool_types.go`'s `ToolSpec`. */
export interface ToolCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    input: string;
    output: string;
    allowedRoles: string[];
    tier?: string;
    image: string;
    serviceAccountName: string;
    args?: string[];
    env?: { name: string; value: string }[];
    resources?: {
      requests?: Record<string, string>;
      limits?: Record<string, string>;
    };
  };
}

/** Minimal slice of the k8s CustomObjectsApi this registry needs — kept small and mockable for tests. */
export interface CustomObjectsApiLike {
  listNamespacedCustomObject(request: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
  }): Promise<{ items?: unknown[] }>;
}

/** Plural resource name used by the `Tool` CRD (matches `config/crd/bases` in controllers/tool-controller). */
export const TOOL_PLURAL = "tools";

/**
 * Discovers the tool catalog from `Tool` custom resources (ADR 0010) —
 * supersedes both the annotated-Deployment discovery (`k8s-discovery.ts`,
 * ADR 0004) and the static build-time manifest approach (`manifest-tool-
 * registry.ts`, ADR 0009). A `Tool` CR is pure metadata (no image rebuild,
 * no dummy Deployment needed just to be discoverable) validated/reconciled
 * by the Go tool-controller, which also confirms the referenced
 * ServiceAccount exists.
 *
 * This is a one-shot `listAll()` read at startup, same shape as the
 * registries it supersedes — NOT a live watch loop (same documented
 * limitation as ADR 0009: catalog only refreshes on orchestrator restart).
 */
export class CrdToolRegistry implements ToolRegistry {
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
  ): CrdToolRegistry {
    return new CrdToolRegistry(namespace, group, version, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async listAll(): Promise<ToolDescriptor[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: TOOL_PLURAL,
    });
    const tools: ToolDescriptor[] = [];
    for (const item of response.items ?? []) {
      const descriptor = toToolDescriptor(item as ToolCustomResource, this.namespace);
      if (descriptor) tools.push(descriptor);
    }
    return tools;
  }
}

function toToolDescriptor(cr: ToolCustomResource, namespace: string): ToolDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.image || !spec?.serviceAccountName) return undefined;

  return {
    id: name,
    name,
    description: `${spec.description}\n\nInput: ${spec.input}\nOutput: ${spec.output}`,
    allowedRoles: spec.allowedRoles ?? [],
    tier: spec.tier,
    jobTemplate: {
      image: spec.image,
      namespace,
      serviceAccountName: spec.serviceAccountName,
      args: spec.args,
      env: Object.fromEntries((spec.env ?? []).map((e) => [e.name, e.value])),
      resources: spec.resources
        ? {
            requests: { cpu: spec.resources.requests?.cpu, memory: spec.resources.requests?.memory },
            limits: { cpu: spec.resources.limits?.cpu, memory: spec.resources.limits?.memory },
          }
        : undefined,
      // Enables ToolRunLauncher to reference this Tool CR by name instead of
      // re-embedding image/serviceAccount into a Job itself (ADR 0010).
      toolRef: name,
    },
  };
}
