import { randomUUID } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { JobTemplate } from "../registry/types.js";

export const TOOLRUN_PLURAL = "toolruns";

/** Reference to a single key in a k8s Secret, in the same namespace as the ToolRun. */
export interface SecretKeySelector {
  name: string;
  key: string;
}

export interface ToolRunLaunchOptions {
  args?: string[];
  /**
   * URL the launched Job POSTs its terminal event to. The gateway's HMAC
   * secret is deliberately NOT part of this options shape: the ToolRun CR
   * only ever carries a `secretRef` (k8s Secret name/key, injected below
   * from the launcher's own constructor param), never a plaintext secret
   * value re-embedded by this process.
   */
  callbackUrl: string;
}

export interface LaunchedToolRun {
  name: string;
  namespace: string;
}

export interface ToolRunLauncherPort {
  launch(template: JobTemplate, options: ToolRunLaunchOptions): Promise<LaunchedToolRun>;
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

/** Creates one `ToolRun` custom resource per direct tool invocation. */
export class ToolRunLauncher implements ToolRunLauncherPort {
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
  ): ToolRunLauncher {
    return new ToolRunLauncher(group, version, callbackSecretRef, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async launch(template: JobTemplate, options: ToolRunLaunchOptions): Promise<LaunchedToolRun> {
    if (!template.toolRef) {
      throw new Error(
        "ToolRunLauncher requires JobTemplate.toolRef (set by CrdCatalogRegistry) — this template came from a registry that doesn't populate it",
      );
    }

    const name = randomUUID();
    const body = {
      apiVersion: `${this.group}/${this.version}`,
      kind: "ToolRun",
      metadata: { name, namespace: template.namespace },
      spec: {
        toolRef: template.toolRef,
        args: options.args ?? template.args,
        callback: {
          url: options.callbackUrl,
          secretRef: this.callbackSecretRef,
        },
      },
    };

    await this.api.createNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: template.namespace,
      plural: TOOLRUN_PLURAL,
      body,
    });

    return { name, namespace: template.namespace };
  }
}
