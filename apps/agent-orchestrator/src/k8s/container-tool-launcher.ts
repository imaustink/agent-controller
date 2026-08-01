import type { JobTemplate } from "../tool-descriptor.js";

export interface LaunchOptions {
  args?: string[];
  env?: Record<string, string>;
  /**
   * HTTP callback mode: the result-receiver URL that the tool Job should POST
   * its `succeeded`/`failed` event to. Required when `natsSubject` is absent.
   */
  callbackUrl?: string;
  /**
   * HTTP callback mode: HMAC secret for signing callback request bodies.
   * Required when `natsSubject` is absent.
   */
  callbackSecret?: string;
  /**
   * NATS mode: subject the tool Job should publish its events to
   * (e.g. `callbacks.<jobId>`). When set, `callbackUrl`/`callbackSecret`
   * are ignored — the tool uses RECIPE_TRANSPORT=nats instead.
   */
  natsSubject?: string;
  /**
   * NATS mode: URL of the NATS server the tool Job should connect to
   * (e.g. `nats://nats.controller-agent.svc.cluster.local:4222`). Required
   * when `natsSubject` is set.
   */
  natsUrl?: string;
  ttlSecondsAfterFinished?: number;
  /**
   * Caller's Open WebUI session id (docs/adr/0012), if any -- set as
   * {@link SessionIDAnnotation} on the launched ToolRun CR so the Go
   * core-controller can copy it onto the Job/Pod for `kubectl describe`
   * debugging. Absent -> no annotation is set, same as before this field
   * existed.
   */
  sessionId?: string;
  /**
   * Per-invocation plaintext values (e.g. the calling user's own linked
   * GitHub token, ADR 0022/0027) that must reach the launched Job as env
   * vars WITHOUT ever being embedded as plaintext in the ToolRun CR itself
   * -- CRs aren't RBAC-hidden the way k8s Secrets are. When non-empty,
   * `ToolRunLauncher.launch()` creates a dedicated k8s Secret first and
   * references it via `ToolRunSpec.secretEnv` (`SecretEnvVar`,
   * controllers/core-controller/api/v1alpha1/toolrun_types.go), which the Go
   * reconciler merges on top of the Tool template's own static `secretEnv`
   * when building the Job. Mirrors `AgentLaunchOptions.secretEnv` exactly.
   */
  secretEnv?: { name: string; value: string }[];
}

/** Well-known annotation key mirroring `SessionIDAnnotation` in controllers/core-controller/internal/controller/run_job.go. */
export const SESSION_ID_ANNOTATION = "controller-agent.dev/session-id";

export interface LaunchedJob {
  name: string;
  namespace: string;
}

/**
 * Port for launching a container tool (ADR 0010). `graph.ts` depends on this
 * interface, not a concrete class, so the launch mechanism can be swapped
 * without touching the agent graph.
 *
 * The only wired implementation is `ToolRunLauncher`, which creates a
 * `ToolRun` custom resource — the Go core-controller
 * (controllers/core-controller/) reconciles that into a hardened k8s Job.
 * The orchestrator process therefore never creates a Job itself and needs no
 * `batch/jobs` RBAC (see charts/agent-orchestrator/templates/rbac.yaml).
 */
export interface ContainerToolLauncher {
  launch(template: JobTemplate, options: LaunchOptions): Promise<LaunchedJob>;
}
