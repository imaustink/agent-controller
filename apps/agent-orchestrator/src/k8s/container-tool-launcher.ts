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
}

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
 * `ToolRun` custom resource — the Go tool-controller
 * (controllers/tool-controller/) reconciles that into a hardened k8s Job.
 * The orchestrator process therefore never creates a Job itself and needs no
 * `batch/jobs` RBAC (see charts/agent-orchestrator/templates/rbac.yaml).
 */
export interface ContainerToolLauncher {
  launch(template: JobTemplate, options: LaunchOptions): Promise<LaunchedJob>;
}
