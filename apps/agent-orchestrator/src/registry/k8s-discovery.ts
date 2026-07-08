import * as k8s from "@kubernetes/client-node";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { ToolRegistry } from "./types.js";

/**
 * NOT WIRED BY DEFAULT — superseded by `../manifest-tool-registry.ts`
 * (ADR 0009). `index.ts` uses `ManifestToolRegistry` instead.
 *
 * This annotation-based approach assumed a tool's live Deployment could be
 * discovered and used as its Job template, but tools are only ever launched
 * on demand as one-shot Jobs (ADR 0005) — there's no reason for a tool's
 * Deployment to actually be running (0 replicas) other than to exist purely
 * as discoverable metadata, which is what motivated moving to a static,
 * build-time manifest per tool instead. Kept here (untested against current
 * wiring, but still unit-tested and functional) in case CRD/live-cluster
 * discovery becomes worth revisiting later — see
 * docs/adr/0009-static-tool-manifests.md and
 * docs/orchestrator.md#open-questions-explicitly-deferred.
 */
export const ANNOTATIONS = {
  tool: "agent-orchestrator.dev/tool",
  description: "agent-orchestrator.dev/description",
  allowedRoles: "agent-orchestrator.dev/allowed-roles",
  tier: "agent-orchestrator.dev/tier",
} as const;

/** Minimal slice of the k8s AppsV1Api this registry needs — kept small and mockable for tests. */
export interface AppsV1ApiLike {
  listNamespacedDeployment(request: { namespace: string }): Promise<k8s.V1DeploymentList>;
}

export class K8sAnnotationToolRegistry implements ToolRegistry {
  constructor(
    private readonly namespace: string,
    private readonly appsApi: AppsV1ApiLike,
  ) {}

  static fromKubeConfig(namespace: string, kubeConfig: k8s.KubeConfig): K8sAnnotationToolRegistry {
    return new K8sAnnotationToolRegistry(namespace, kubeConfig.makeApiClient(k8s.AppsV1Api));
  }

  async listAll(): Promise<ToolDescriptor[]> {
    const response = await this.appsApi.listNamespacedDeployment({ namespace: this.namespace });
    const tools: ToolDescriptor[] = [];
    for (const deployment of response.items) {
      const descriptor = toToolDescriptor(deployment, this.namespace);
      if (descriptor) tools.push(descriptor);
    }
    return tools;
  }
}

function toToolDescriptor(deployment: k8s.V1Deployment, namespace: string): ToolDescriptor | undefined {
  const annotations = deployment.metadata?.annotations ?? {};
  if (annotations[ANNOTATIONS.tool] !== "true") return undefined;

  const name = deployment.metadata?.name;
  const podSpec = deployment.spec?.template.spec;
  const image = podSpec?.containers[0]?.image;
  const serviceAccountName = podSpec?.serviceAccountName;
  // Skip malformed entries rather than launching an under-specified Job.
  if (!name || !image || !serviceAccountName) return undefined;

  const allowedRoles = (annotations[ANNOTATIONS.allowedRoles] ?? "")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

  return {
    id: name,
    name,
    description: annotations[ANNOTATIONS.description] ?? name,
    allowedRoles,
    tier: annotations[ANNOTATIONS.tier],
    jobTemplate: {
      image,
      namespace,
      serviceAccountName,
    },
  };
}
