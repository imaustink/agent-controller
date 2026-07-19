import * as k8s from "@kubernetes/client-node";
import { makeCrdWatcher, type CrdChangeEvent, type WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { AgentDescriptor, AgentRegistry } from "./types.js";

/** Shape of an `Agent` custom resource (`<group>/<version>`, kind `Agent`) — mirrors
 * `controllers/core-controller/api/v1alpha1/agent_types.go`'s `AgentSpec`. */
export interface AgentCustomResource {
  metadata: { name: string };
  spec: {
    description: string;
    input: string;
    output: string;
    allowedRoles: string[];
    tier?: string;
    orchestratorPrompt?: string;
    // agentPrompt, image, serviceAccountName, env, secretEnv, resources,
    // skillRefs, model, maxIterations are launch/loop-internal details this
    // orchestrator never needs — it only ever references the Agent CR by
    // name (agentRunTemplate.agentRef) when creating an AgentRun.
  };
}

/** Plural resource name used by the `Agent` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const AGENT_PLURAL = "agents";

/**
 * Discovers the agent catalog from `Agent` custom resources — mirrors
 * `../registry/crd-tool-registry.ts` exactly. `listAll()` is a one-shot read
 * used only for the initial catalog at startup; `watch()` (ADR 0020) keeps
 * it current afterward via a live k8s watch, same shape as
 * `CrdToolRegistry`.
 */
export class CrdAgentRegistry implements AgentRegistry {
  constructor(
    private readonly namespace: string,
    private readonly group: string,
    private readonly version: string,
    private readonly api: CustomObjectsApiLike,
    /** Absent in tests that only exercise `listAll()`; real instances always pass one via `fromKubeConfig`. */
    private readonly watchFn?: WatchCrdFn,
  ) {}

  static fromKubeConfig(
    namespace: string,
    group: string,
    version: string,
    kubeConfig: k8s.KubeConfig,
  ): CrdAgentRegistry {
    return new CrdAgentRegistry(
      namespace,
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      makeCrdWatcher(kubeConfig),
    );
  }

  async listAll(): Promise<AgentDescriptor[]> {
    const response = await this.api.listNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: this.namespace,
      plural: AGENT_PLURAL,
    });
    const agents: AgentDescriptor[] = [];
    for (const item of response.items ?? []) {
      const descriptor = toAgentDescriptor(item as AgentCustomResource, this.namespace);
      if (descriptor) agents.push(descriptor);
    }
    return agents;
  }

  watch(
    onChange: (event: CrdChangeEvent<AgentDescriptor>) => void,
    onError?: (err: unknown) => void,
  ): { stop: () => void } {
    if (!this.watchFn) throw new Error("CrdAgentRegistry.watch() requires a watchFn (construct via fromKubeConfig)");
    return this.watchFn(
      { group: this.group, version: this.version, namespace: this.namespace, plural: AGENT_PLURAL },
      (phase, obj) => {
        const cr = obj as AgentCustomResource;
        const id = cr?.metadata?.name;
        if (!id) return;
        if (phase === "DELETED") {
          onChange({ type: "delete", id });
          return;
        }
        const descriptor = toAgentDescriptor(cr, this.namespace);
        if (descriptor) onChange({ type: "upsert", descriptor });
      },
      onError,
    );
  }
}

export function toAgentDescriptor(cr: AgentCustomResource, namespace: string): AgentDescriptor | undefined {
  const name = cr.metadata?.name;
  const spec = cr.spec;
  if (!name || !spec?.description) return undefined;

  return {
    id: name,
    name,
    description: `${spec.description}\n\nInput: ${spec.input}\nOutput: ${spec.output}`,
    allowedRoles: spec.allowedRoles ?? [],
    tier: spec.tier,
    orchestratorPrompt: spec.orchestratorPrompt,
    agentRunTemplate: {
      namespace,
      agentRef: name,
    },
  };
}
