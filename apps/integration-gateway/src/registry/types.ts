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
  /** Name of the Tool custom resource this template was resolved from. */
  toolRef?: string;
}

export interface AgentRunTemplate {
  namespace: string;
  /** Name of the Agent custom resource this run targets. */
  agentRef: string;
}

export interface CatalogEntry {
  kind: "tool" | "agent";
  id: string;
  allowedRoles: string[];
  jobTemplate?: JobTemplate;
  agentRunTemplate?: AgentRunTemplate;
}

export interface CatalogRegistry {
  getById(id: string): Promise<CatalogEntry | undefined>;
}

/** A {@link CatalogEntry} known to have resolved (never `undefined`) — used once `getById`'s result has been null-checked. */
export type ResolvedCatalogEntry = CatalogEntry;
