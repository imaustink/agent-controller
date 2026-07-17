import * as k8s from "@kubernetes/client-node";
import type { LocalToolSpec, ToolDescriptor } from "../tool-descriptor.js";
import type { CustomObjectsApiLike } from "./crd-tool-registry.js";
import type { ToolRegistry } from "./types.js";

/**
 * Shape of a `LocalTool` custom resource (`<group>/<version>`, kind
 * `LocalTool`) — mirrors
 * `controllers/core-controller/api/v1alpha1/localtool_types.go`'s
 * `LocalToolSpec` (ADR 0014).
 */
export interface LocalToolCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    input: string;
    output: string;
    allowedRoles: string[];
    tier?: string;
    runtime: LocalToolSpec["runtime"];
    package?: string;
    version?: string;
    entry?: string;
    sourceURL?: string;
    checksum?: string;
    env?: { name: string; value: string }[];
    secretEnv?: { name: string; secretRef: { name: string; key: string } }[];
    network?: boolean;
    timeoutSeconds?: number;
    resources?: {
      requests?: Record<string, string>;
      limits?: Record<string, string>;
    };
  };
}

/** Plural resource name used by the `LocalTool` CRD (matches config/crd/bases). */
export const LOCAL_TOOL_PLURAL = "localtools";

/**
 * Discovers LocalTools from `LocalTool` custom resources (ADR 0014). Unlike
 * {@link CrdToolRegistry} (Tools launched as k8s Jobs), a LocalTool is executed
 * in-pod by a per-language executor sidecar — so each descriptor carries a
 * `localExec` spec instead of a `jobTemplate`. The resulting descriptors are
 * unioned with the Tool catalog and indexed into the same RAG store, so skills
 * reference either kind transparently by CR name.
 *
 * One-shot `listAll()` read at startup, same limitation as CrdToolRegistry
 * (refreshes only on orchestrator restart, not a live watch).
 */
export class CrdLocalToolRegistry implements ToolRegistry {
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
  ): CrdLocalToolRegistry {
    return new CrdLocalToolRegistry(namespace, group, version, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async listAll(): Promise<ToolDescriptor[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: LOCAL_TOOL_PLURAL,
    });
    const tools: ToolDescriptor[] = [];
    for (const item of response.items ?? []) {
      const descriptor = toLocalToolDescriptor(item as LocalToolCustomResource);
      if (descriptor) tools.push(descriptor);
    }
    return tools;
  }
}

export function toLocalToolDescriptor(cr: LocalToolCustomResource): ToolDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.runtime) return undefined;

  const localExec: LocalToolSpec = {
    runtime: spec.runtime,
    package: spec.package,
    version: spec.version,
    entry: spec.entry,
    sourceUrl: spec.sourceURL,
    checksum: spec.checksum,
    env: Object.fromEntries((spec.env ?? []).map((e) => [e.name, e.value])),
    secretEnv: spec.secretEnv,
    network: spec.network ?? false,
    timeoutSeconds: spec.timeoutSeconds,
    resources: spec.resources
      ? {
          requests: { cpu: spec.resources.requests?.cpu, memory: spec.resources.requests?.memory },
          limits: { cpu: spec.resources.limits?.cpu, memory: spec.resources.limits?.memory },
        }
      : undefined,
  };

  return {
    id: name,
    name,
    description: `${spec.description}\n\nInput: ${spec.input}\nOutput: ${spec.output}`,
    allowedRoles: spec.allowedRoles ?? [],
    tier: spec.tier,
    localExec,
  };
}
