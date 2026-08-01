import * as k8s from "@kubernetes/client-node";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import type { AgentRunTemplate } from "../agents/types.js";
import { SESSION_ID_ANNOTATION } from "./container-tool-launcher.js";
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
  /**
   * Per-invocation plaintext values (e.g. the calling user's own linked
   * GitHub token) that must reach the launched Job as env vars WITHOUT ever
   * being embedded as plaintext in the AgentRun CR itself -- CRs aren't
   * RBAC-hidden the way k8s Secrets are. When non-empty, `launch()` creates a
   * dedicated k8s Secret first and references it via `AgentRunSpec.secretEnv`
   * (`SecretEnvVar`, controllers/core-controller/api/v1alpha1/agentrun_types.go),
   * which the Go reconciler merges on top of the Agent template's own static
   * `secretEnv` when building the Job. Requires a `secretApi` to have been
   * passed to the constructor (see `SecretApiLike` below).
   */
  secretEnv?: { name: string; value: string }[];
  /**
   * Names of PRE-EXISTING Secrets, created elsewhere for this launch, that the
   * AgentRun should become the owner of -- so Kubernetes garbage-collects them
   * with the run exactly as it does the identity Secret above.
   *
   * Today this is the `claude-remote` write-back grant, minted by the gateway
   * during the authorization pre-flight (docs/adr/0034). It is the one
   * credential record with a lifetime, and Kubernetes has no TTL on a Secret --
   * but this launcher already had to solve "attach an owner to a Secret created
   * before the CR existed" for its own, so a grant joins that mechanism rather
   * than needing a sweeper of its own. The controller's retention pass then
   * reclaims the run and everything it owns
   * (controllers/core-controller/internal/controller/agentrun_controller.go).
   *
   * Best-effort by construction: a failure to attach an owner leaves a grant that
   * still expires on its own terms, so it must never fail the launch.
   */
  ownedSecretNames?: string[];
  /**
   * Caller's Open WebUI session id (docs/adr/0012), if any -- set as
   * {@link SESSION_ID_ANNOTATION} on the launched AgentRun CR, mirroring
   * ToolRunLauncher. Absent -> no annotation is set.
   */
  sessionId?: string;
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
 * Minimal slice of k8s CoreV1Api this launcher needs to back per-invocation
 * identity `secretEnv` (a caller's own linked GitHub token, never the shared
 * static credential) — kept small and mockable, same narrowing discipline as
 * {@link CustomObjectsApiLike}. Optional on the constructor: only required
 * when a caller ever launches with `options.secretEnv` non-empty. Shared
 * with {@link ../k8s/toolrun-launcher.ts!ToolRunLauncher}, which backs the
 * same per-invocation `secretEnv` mechanism for container Tools (ADR 0032).
 */
export interface SecretApiLike {
  createNamespacedSecret(request: { namespace: string; body: unknown }): Promise<{ metadata?: { name?: string } }>;
  patchNamespacedSecret(request: { name: string; namespace: string; body: unknown }): Promise<unknown>;
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
      }): Promise<{ metadata?: { uid?: string } }>;
    },
    /** Absent in callers/tests that never launch with `options.secretEnv` (today's default). Real instances constructed via `fromKubeConfig` always pass one. */
    private readonly secretApi?: SecretApiLike,
  ) {}

  static fromKubeConfig(group: string, version: string, kubeConfig: k8s.KubeConfig): AgentRunLauncher {
    return new AgentRunLauncher(
      group,
      version,
      kubeConfig.makeApiClient(k8s.CustomObjectsApi),
      kubeConfig.makeApiClient(k8s.CoreV1Api),
    );
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

    // Per-invocation identity secretEnv (e.g. GITHUB_TOKEN for the CALLING
    // user, not the shared bot credential): create a dedicated k8s Secret up
    // front and reference it from the CR by name/key only -- the plaintext
    // value must never be embedded in the AgentRun CR itself, since CRs
    // aren't RBAC-hidden the way Secrets are.
    let secretName: string | undefined;
    let secretEnvSpec: { name: string; secretRef: { name: string; key: string } }[] | undefined;
    if (options.secretEnv && options.secretEnv.length > 0) {
      if (!this.secretApi) {
        throw new Error(
          "AgentRunLauncher.launch() was given options.secretEnv but no SecretApiLike was configured -- " +
            "construct via fromKubeConfig (which wires a CoreV1Api client) to use per-invocation identity secretEnv",
        );
      }
      // `name` is a randomUUID() per caller (graph.ts's delegateToAgent), so
      // this suffix is still a valid DNS-1123 Secret name.
      secretName = `${name}-identity`;
      const stringData: Record<string, string> = {};
      for (const entry of options.secretEnv) stringData[entry.name] = entry.value;
      // No ownerReference yet -- the AgentRun CR doesn't exist (no uid) until
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
      kind: "AgentRun",
      metadata: {
        name,
        namespace: template.namespace,
        ...(options.sessionId ? { annotations: { [SESSION_ID_ANNOTATION]: options.sessionId } } : {}),
      },
      spec: {
        agentRef: template.agentRef,
        goal: options.goal,
        callback,
        ...(options.timeoutSeconds ? { timeoutSeconds: options.timeoutSeconds } : {}),
        ...(secretEnvSpec ? { secretEnv: secretEnvSpec } : {}),
      },
    };

    const created = await this.api.createNamespacedCustomObject({
      group: this.group,
      version: this.version,
      namespace: template.namespace,
      plural: AGENTRUN_PLURAL,
      body,
    });

    // A real cluster always returns the created object's uid; skip the
    // ownerReference patch rather than fail the whole launch if it's ever
    // missing (e.g. a bare-bones test double) -- the Secrets are still created
    // and correctly referenced, just without GC-on-delete.
    const uid = created?.metadata?.uid;
    if (uid) {
      // The identity Secret this launcher created, plus anything created for
      // this launch elsewhere that should share its fate (the write-back grant,
      // docs/adr/0034).
      const toOwn = [...(secretName ? [secretName] : []), ...(options.ownedSecretNames ?? [])];
      for (const target of toOwn) {
        await this.adoptSecret(target, template.namespace, name, uid);
      }
    }

    return { name, namespace: template.namespace };
  }

  /**
   * Makes the just-created AgentRun the owner of an existing Secret, so
   * Kubernetes deletes it when the run is reclaimed.
   *
   * Never throws: ownership is a cleanup optimization, and an un-owned Secret is
   * a stray object rather than a broken run -- failing the launch over it would
   * trade a leak for an outage. The grant this also covers stops authorizing at
   * its own `expiresAt` regardless of whether it was ever collected.
   */
  private async adoptSecret(secretName: string, namespace: string, runName: string, uid: string): Promise<void> {
    try {
      await this.secretApi?.patchNamespacedSecret({
        name: secretName,
        namespace,
        // @kubernetes/client-node's patchNamespacedSecret (as actually
        // installed) defaults its Content-Type to
        // "application/json-patch+json" (RFC 6902 JSON Patch) rather than a
        // merge patch -- see ObjectSerializer.getPreferredMediaType, which
        // always prefers the first JSON-like media type in its own fixed
        // candidate list. A JSON Patch "add" op is used here accordingly
        // (not the merge-style object a newer/older client version might
        // expect).
        body: [
          {
            op: "add",
            path: "/metadata/ownerReferences",
            value: [
              {
                apiVersion: `${this.group}/${this.version}`,
                kind: "AgentRun",
                name: runName,
                uid,
                controller: true,
                blockOwnerDeletion: true,
              },
            ],
          },
        ],
      });
    } catch (err) {
      console.error(
        `could not make AgentRun ${runName} the owner of Secret ${secretName}; it will not be garbage-collected with the run: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
