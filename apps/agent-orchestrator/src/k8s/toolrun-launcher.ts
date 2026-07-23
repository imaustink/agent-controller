import { randomUUID } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { JobTemplate } from "../tool-descriptor.js";
import type { SecretApiLike } from "./agentrun-launcher.js";
import { SESSION_ID_ANNOTATION, type ContainerToolLauncher, type LaunchedJob, type LaunchOptions } from "./container-tool-launcher.js";

/** Plural resource name used by the `ToolRun` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const TOOLRUN_PLURAL = "toolruns";

/** Reference to a single key in a k8s Secret, in the same namespace as the ToolRun. */
export interface SecretKeySelector {
  name: string;
  key: string;
}

/**
 * Creates one `ToolRun` custom resource per tool/sub-agent invocation (ADR
 * 0010) instead of creating a k8s Job directly — the Go core-controller
 * (controllers/core-controller/) is the ONLY thing that creates Jobs now.
 * This is why the orchestrator's own RBAC no longer needs `batch/jobs`
 * permissions at all (see charts/agent-controller/charts/agent-orchestrator/templates/rbac.yaml).
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
      }): Promise<{ metadata?: { uid?: string } }>;
    },
    /** Absent in callers/tests that never launch with `options.secretEnv` (today's default). Real instances constructed via `fromKubeConfig` always pass one. */
    private readonly secretApi?: SecretApiLike,
  ) {}

  static fromKubeConfig(
    group: string,
    version: string,
    callbackSecretRef: SecretKeySelector,
    kubeConfig: k8s.KubeConfig,
  ): ToolRunLauncher {
    return new ToolRunLauncher(
      group,
      version,
      callbackSecretRef,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      kubeConfig.makeApiClient(k8s.CoreV1Api),
    );
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
    // the core-controller inspects which fields are present to decide which
    // env vars to inject into the launched Job.
    const callback = options.natsSubject
      ? { natsSubject: options.natsSubject, natsUrl: options.natsUrl }
      : { url: options.callbackUrl, secretRef: this.callbackSecretRef };

    // Per-invocation identity secretEnv (e.g. GITHUB_TOKEN for the CALLING
    // user, not any shared bot credential, ADR 0027): create a dedicated k8s
    // Secret up front and reference it from the CR by name/key only -- the
    // plaintext value must never be embedded in the ToolRun CR itself, since
    // CRs aren't RBAC-hidden the way Secrets are. Mirrors AgentRunLauncher's
    // identical mechanism (agentrun-launcher.ts).
    let secretName: string | undefined;
    let secretEnvSpec: { name: string; secretRef: { name: string; key: string } }[] | undefined;
    if (options.secretEnv && options.secretEnv.length > 0) {
      if (!this.secretApi) {
        throw new Error(
          "ToolRunLauncher.launch() was given options.secretEnv but no SecretApiLike was configured -- " +
            "construct via fromKubeConfig (which wires a CoreV1Api client) to use per-invocation identity secretEnv",
        );
      }
      // `name` is a randomUUID() above, so this suffix is still a valid
      // DNS-1123 Secret name.
      secretName = `${name}-identity`;
      const stringData: Record<string, string> = {};
      for (const entry of options.secretEnv) stringData[entry.name] = entry.value;
      // No ownerReference yet -- the ToolRun CR doesn't exist (no uid) until
      // createNamespacedCustomObject below succeeds; patched in afterward.
      await this.secretApi.createNamespacedSecret({
        namespace: template.namespace,
        body: { metadata: { name: secretName }, stringData },
      });
      secretEnvSpec = options.secretEnv.map((entry) => ({
        name: entry.name,
        secretRef: { name: secretName!, key: entry.name },
      }));
    }

    const body = {
      apiVersion: `${this.group}/${this.version}`,
      kind: "ToolRun",
      metadata: {
        name,
        namespace: template.namespace,
        ...(options.sessionId ? { annotations: { [SESSION_ID_ANNOTATION]: options.sessionId } } : {}),
      },
      spec: {
        toolRef: template.toolRef,
        args: options.args ?? template.args,
        callback,
        ...(secretEnvSpec ? { secretEnv: secretEnvSpec } : {}),
      },
    };

    const created = await this.api.createNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: template.namespace,
      plural: TOOLRUN_PLURAL,
      body,
    });

    if (secretName) {
      const uid = created?.metadata?.uid;
      // A real cluster always returns the created object's uid; skip the
      // ownerReference patch rather than fail the whole launch if it's ever
      // missing (e.g. a bare-bones test double) -- the Secret is still
      // created and correctly referenced, just without GC-on-delete.
      if (uid) {
        await this.secretApi!.patchNamespacedSecret({
          name: secretName,
          namespace: template.namespace,
          // Same JSON-Patch media-type quirk as AgentRunLauncher -- see its
          // comment on the equivalent patch call.
          body: [
            {
              op: "add",
              path: "/metadata/ownerReferences",
              value: [
                {
                  apiVersion: `${this.group}/${this.version}`,
                  kind: "ToolRun",
                  name,
                  uid,
                  controller: true,
                  blockOwnerDeletion: true,
                },
              ],
            },
          ],
        });
      }
    }

    return { name, namespace: template.namespace };
  }
}
