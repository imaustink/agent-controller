import { randomUUID } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { JobTemplate } from "../tool-descriptor.js";
import type { ContainerToolLauncher, LaunchedJob, LaunchOptions } from "./container-tool-launcher.js";

/** Plural resource name used by the `ToolRun` CRD (matches `config/crd/bases` in controllers/tool-controller). */
export const TOOLRUN_PLURAL = "toolruns";

/** Reference to a single key in a k8s Secret, in the same namespace as the ToolRun. */
export interface SecretKeySelector {
  name: string;
  key: string;
}

/**
 * Creates one `ToolRun` custom resource per tool/sub-agent invocation (ADR
 * 0010) instead of creating a k8s Job directly — the Go tool-controller
 * (controllers/tool-controller/) is the ONLY thing that creates Jobs now.
 * This is why the orchestrator's own RBAC no longer needs `batch/jobs`
 * permissions at all (see charts/controller-agent/charts/agent-orchestrator/templates/rbac.yaml).
 *
 * Result/progress payloads still flow over the existing HMAC callback
 * protocol unchanged (ADR 0006) — `options.callbackUrl` is passed straight
 * through. `options.callbackSecret` (the raw HMAC value) is deliberately
 * IGNORED here: the ToolRun CR only ever carries a `secretRef` (k8s Secret
 * name/key), never a plaintext secret, so the launched Job's controller-
 * created container gets the value via `secretKeyRef`, not via this
 * process re-embedding it into a CR.
 */
export class ToolRunLauncher implements ContainerToolLauncher {
  constructor(
    private readonly group: string,
    private readonly version: string,
    private readonly callbackSecretRef: SecretKeySelector,
    private readonly api: CustomObjectsApiLike & {
      createNamespacedCustomObject(request: {
        group: string;
        version: string;
        namespace: string;
        plural: string;
        body: unknown;
      }): Promise<unknown>;
    },
  ) {}

  static fromKubeConfig(
    group: string,
    version: string,
    callbackSecretRef: SecretKeySelector,
    kubeConfig: k8s.KubeConfig,
  ): ToolRunLauncher {
    return new ToolRunLauncher(group, version, callbackSecretRef, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  async launch(template: JobTemplate, options: LaunchOptions): Promise<LaunchedJob> {
    if (!template.toolRef) {
      throw new Error(
        "ToolRunLauncher requires JobTemplate.toolRef (set by CrdToolRegistry) — " +
          "this template came from a registry that doesn't populate it",
      );
    }

    // Bare UUID (valid DNS-1123) rather than "toolrun-<uuid>": the Go
    // controller prefixes the owned Job's name with the kind ("toolrun-")
    // for cross-kind uniqueness, so a prefixed CR name would produce a
    // stuttering "toolrun-toolrun-<uuid>" Job name.
    const name = randomUUID();

    // Build the callback block: NATS mode when natsSubject is set, HTTP mode
    // otherwise (backward compatible). Both paths are mutually exclusive —
    // the tool-controller inspects which fields are present to decide which
    // env vars to inject into the launched Job.
    const callback = options.natsSubject
      ? { natsSubject: options.natsSubject, natsUrl: options.natsUrl }
      : { url: options.callbackUrl, secretRef: this.callbackSecretRef };

    const body = {
      apiVersion: `${this.group}/${this.version}`,
      kind: "ToolRun",
      metadata: { name, namespace: template.namespace },
      spec: {
        toolRef: template.toolRef,
        args: options.args ?? template.args,
        callback,
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
