import * as k8s from "@kubernetes/client-node";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { AgentRunTemplate } from "../agents/types.js";
import type { SecretKeySelector } from "./toolrun-launcher.js";

/** Plural resource name used by the `AgentRun` CRD (matches `config/crd/bases` in controllers/core-controller). */
export const AGENTRUN_PLURAL = "agentruns";

export interface AgentLaunchOptions {
  /** The initial user turn / task objective, delivered via AgentRun.spec.goal (like ToolRun's args — not a NATS message). */
  goal: string;
  /**
   * Callback block the AgentRun CR still carries today (Go CRD field is
   * currently required) even though the bidirectional NATS protocol is the
   * actual result channel for agents — vestigial until the AgentRun CRD
   * makes `callback` optional and the controller injects NATS env instead.
   * Mirrors ToolRunLauncher's NATS-vs-HTTP branching (toolrun-launcher.ts):
   * when `natsSubject` is set the controller takes the NATS path (no
   * secretRef needed) instead of validating `callbackSecretRef` as a real
   * k8s Secret reference — required here since in NATS mode
   * `callbackSecretRef.name` is legitimately unset (config.ts only requires
   * AGENT_CALLBACK_SECRET_REF_NAME when AGENT_NATS_URL is absent), and the
   * Go controller rejects an empty secretRef.name on the HTTP path.
   */
  callbackUrl: string;
  callbackSecretRef: SecretKeySelector;
  natsUrl?: string;
  natsSubject?: string;
  /** Bounds the Job's activeDeadlineSeconds; agents typically need longer than tools (may wait on a human). */
  timeoutSeconds?: number;
}

export interface LaunchedAgentRun {
  name: string;
  namespace: string;
}

/**
 * Port for launching an agent (mirrors {@link ContainerToolLauncher}).
 * `graph.ts` depends on this interface, not the concrete class, so the
 * launch mechanism can be swapped without touching the agent graph.
 */
export interface AgentRunLauncherPort {
  /**
   * `name` is chosen by the CALLER (not generated internally, unlike
   * ToolRunLauncher) because the graph must subscribe to this exact run's
   * NATS up subject BEFORE creating the CR — otherwise a fast-replying agent
   * could publish before a late subscription exists.
   */
  launch(template: AgentRunTemplate, name: string, options: AgentLaunchOptions): Promise<LaunchedAgentRun>;
}

/**
 * Creates one `AgentRun` custom resource per agent delegation — the Go
 * core-controller (controllers/core-controller/) reconciles it into a
 * hardened Job, exactly like ToolRunLauncher does for tools. Mirrors
 * ../k8s/toolrun-launcher.ts structurally.
 */
export class AgentRunLauncher implements AgentRunLauncherPort {
  constructor(
    private readonly group: string,
    private readonly version: string,
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

  static fromKubeConfig(group: string, version: string, kubeConfig: k8s.KubeConfig): AgentRunLauncher {
    return new AgentRunLauncher(group, version, kubeConfig.makeApiClient(k8s.CustomObjectsApi));
  }

  /**
   * Creates the AgentRun CR under the caller-chosen `name` and returns it —
   * the caller is expected to have ALREADY subscribed to that name's up
   * subject (via agentSubjects) before calling this, so no `ready`/`reply`
   * message from the newly-launched pod can be missed by a late subscription.
   */
  async launch(template: AgentRunTemplate, name: string, options: AgentLaunchOptions): Promise<LaunchedAgentRun> {
    // Build the callback block: NATS mode when natsSubject is set, HTTP mode
    // otherwise (backward compatible) — same branching as ToolRunLauncher.
    const callback = options.natsSubject
      ? { natsSubject: options.natsSubject, natsUrl: options.natsUrl }
      : { url: options.callbackUrl, secretRef: options.callbackSecretRef };

    const body = {
      apiVersion: `${this.group}/${this.version}`,
      kind: "AgentRun",
      metadata: { name, namespace: template.namespace },
      spec: {
        agentRef: template.agentRef,
        goal: options.goal,
        callback,
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
