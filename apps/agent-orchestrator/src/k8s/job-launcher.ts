import { randomUUID } from "node:crypto";
import * as k8s from "@kubernetes/client-node";
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
 * Port every Job launcher implements (ADR 0010). `graph.ts` depends on this,
 * not a concrete class, so the ToolRun-CR-based `ToolRunLauncher` can be
 * swapped in for `K8sJobLauncher` without changing the agent graph.
 */
export interface JobLauncher {
  launch(template: JobTemplate, options: LaunchOptions): Promise<LaunchedJob>;
}

/** Minimal slice of the k8s BatchV1Api this launcher needs — kept small and mockable for tests. */
export interface BatchV1ApiLike {
  createNamespacedJob(request: { namespace: string; body: k8s.V1Job }): Promise<k8s.V1Job>;
  readNamespacedJobStatus(request: { name: string; namespace: string }): Promise<k8s.V1Job>;
  deleteNamespacedJob(request: { name: string; namespace: string }): Promise<unknown>;
}

/**
 * Creates one k8s Job per tool/sub-agent invocation via `@kubernetes/client-node`
 * (ADR 0005) — never shells out to `kubectl`. Every launched container gets
 * the same hardened run contract as recipe-scraper (docs/security.md):
 * dropped capabilities, read-only root filesystem, non-root, no privilege
 * escalation.
 *
 * NOT WIRED BY DEFAULT — superseded by `../k8s/toolrun-launcher.ts` (ADR
 * 0010). `index.ts` uses `ToolRunLauncher` instead, which creates a ToolRun
 * CR and lets a separate Go controller (controllers/tool-controller/) own
 * Job creation/RBAC instead of the orchestrator process itself. Kept here
 * (still unit-tested and functional) since this repo isn't a git repo and
 * has no other safety net for deleted code — see docs/adr/0010.
 */
export class K8sJobLauncher implements JobLauncher {
  constructor(private readonly batchApi: BatchV1ApiLike) {}

  static fromKubeConfig(kubeConfig: k8s.KubeConfig): K8sJobLauncher {
    return new K8sJobLauncher(kubeConfig.makeApiClient(k8s.BatchV1Api));
  }

  async launch(template: JobTemplate, options: LaunchOptions): Promise<LaunchedJob> {
    const jobName = `tool-${randomUUID()}`;
    const env: k8s.V1EnvVar[] = [
      ...Object.entries({ ...template.env, ...options.env }).map(([name, value]) => ({ name, value })),
      { name: "CALLBACK_URL", value: options.callbackUrl },
      { name: "CALLBACK_SECRET", value: options.callbackSecret },
    ];

    const job: k8s.V1Job = {
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name: jobName, namespace: template.namespace },
      spec: {
        ttlSecondsAfterFinished: options.ttlSecondsAfterFinished ?? 300,
        backoffLimit: 0,
        template: {
          spec: {
            serviceAccountName: template.serviceAccountName,
            restartPolicy: "Never",
            containers: [
              {
                name: "tool",
                image: template.image,
                args: options.args ?? template.args,
                env,
                resources: template.resources,
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  runAsNonRoot: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    };

    await this.batchApi.createNamespacedJob({ namespace: template.namespace, body: job });
    return { name: jobName, namespace: template.namespace };
  }

  async getStatus(job: LaunchedJob): Promise<k8s.V1JobStatus | undefined> {
    const response = await this.batchApi.readNamespacedJobStatus({ name: job.name, namespace: job.namespace });
    return response.status;
  }

  async delete(job: LaunchedJob): Promise<void> {
    await this.batchApi.deleteNamespacedJob({ name: job.name, namespace: job.namespace });
  }
}
