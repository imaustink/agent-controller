import type { JobTemplate } from "../tool-descriptor.js";

export interface LaunchOptions {
  args?: string[];
  env?: Record<string, string>;
  /** Result-callback URL, reusing the existing @recipe-agent/messaging callback protocol. */
  callbackUrl: string;
  callbackSecret: string;
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
