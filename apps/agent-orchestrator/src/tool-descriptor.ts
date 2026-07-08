/**
 * k8s Job template needed to run a tool/sub-agent — everything the launcher
 * needs beyond the per-call args/env (see docs/orchestrator.md#4-kubernetes-job-launcher).
 */
export interface JobTemplate {
  image: string;
  namespace: string;
  serviceAccountName: string;
  args?: string[];
  env?: Record<string, string>;
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  /**
   * Name of the Tool custom resource this template was resolved from (ADR
   * 0010). Only populated by `CrdToolRegistry` — required by
   * `ToolRunLauncher` (which creates a ToolRun CR referencing a Tool by
   * name, rather than embedding image/serviceAccount directly into a Job
   * itself). `ManifestToolRegistry`/`K8sAnnotationToolRegistry` leave this
   * undefined since they're paired with `K8sJobLauncher`, which ignores it.
   */
  toolRef?: string;
}

/**
 * A single tool or sub-agent that can be launched as a k8s Job. This is what
 * gets embedded/upserted into the RAG index (see ADR 0003/0004).
 */
export interface ToolDescriptor {
  /** Stable identifier; also used as the vector-store point id. */
  id: string;
  name: string;
  /** Natural-language description — this is the text that gets embedded. */
  description: string;
  /** Roles/scopes allowed to invoke this tool; enforced as a retrieval filter (ADR 0004). */
  allowedRoles: string[];
  jobTemplate: JobTemplate;
  /** Optional coarse risk/cost tier, for future quota/authorization use. */
  tier?: string;
}
