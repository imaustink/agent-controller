import * as k8s from "@kubernetes/client-node";
import type { AgentRunTemplate } from "../registry/types.js";
import type { SecretKeySelector } from "./toolrun-launcher.js";

export const AGENTRUN_PLURAL = "agentruns";

export interface AgentRunLaunchOptions {
  goal: string;
  callbackUrl: string;
  /** Present for API symmetry; ignored because the CR only carries secretRef. */
  callbackSecret?: string;
  timeoutSeconds?: number;
}

export interface LaunchedAgentRun {
  name: string;
  namespace: string;
}

export interface AgentRunLauncherPort {
  launch(template: AgentRunTemplate, name: string, options: AgentRunLaunchOptions): Promise<LaunchedAgentRun>;
}

interface CreateCustomObjectsApiLike {
  createNamespacedCustomObject(request: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    body: unknown;
  }): Promise<unknown>;
}

/** Creates one `AgentRun` custom resource per direct agent invocation. */
export class AgentRunLauncher implements AgentRunLauncherPort {
  constructor(
    private readonly group: string,
    private readonly version: string,
    private readonly callbackSecretRef: SecretKeySelector,
    private readonly api: CreateCustomObjectsApiLike,
  ) {}

  static fromKubeConfig(
    group: string,
    version: string,
    callbackSecretRef: SecretKeySelector,
    kubeConfig: k8s.KubeConfig,
  ): AgentRunLauncher {
    return new AgentRunLauncher(group, version, callbackSecretRef, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async launch(template: AgentRunTemplate, name: string, options: AgentRunLaunchOptions): Promise<LaunchedAgentRun> {
    const body = {
      apiVersion: `${this.group}/${this.version}`,
      kind: "AgentRun",
      metadata: { name, namespace: template.namespace },
      spec: {
        agentRef: template.agentRef,
        goal: options.goal,
        callback: {
          url: options.callbackUrl,
          secretRef: this.callbackSecretRef,
        },
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
      },
    };

    await this.api.createNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: template.namespace,
      plural: AGENTRUN_PLURAL,
      body,
    });

    return { name, namespace: template.namespace };
  }
}
