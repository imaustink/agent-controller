import { randomUUID } from "node:crypto";

/** Central configuration for the orchestrator container. */
export interface AppConfig {
  /** k8s namespace tool/sub-agent Jobs are launched into. */
  namespace: string;
  /** API group for the Tool/Skill/ToolRun CRDs (ADR 0010), e.g. `core.controller-agent.dev`. */
  crdGroup: string;
  /** API version for the Tool/Skill/ToolRun CRDs (ADR 0010), e.g. `v1alpha1`. */
  crdVersion: string;
  /** NATS server URL for the bidirectional agent control protocol (Phase 7). */
  natsUrl: string;
  /** Subject prefix for agent up/down subjects (see @controller-agent/messaging agentSubjects). */
  natsSubjectPrefix: string;
  qdrantUrl: string;
  qdrantApiKey: string | undefined;
  qdrantCollection: string;
  qdrantVectorSize: number;
  /** Collection name for the skills catalog (docs/adr/0008) - same Qdrant instance, separate collection. */
  skillsQdrantCollection: string;
  /** Collection name for the agent catalog, same Qdrant instance, separate collection from tools/skills. */
  agentsQdrantCollection: string;
  embeddingModel: string;
  selectionModel: string;
  /** Max candidate skills retrieved per request, before skill selection (docs/adr/0008). */
  skillTopK: number;
  /** Max candidate agents retrieved per request, before delegate selection (mirrors skillTopK). */
  agentTopK: number;
  /** Bounds an AgentRun's activeDeadlineSeconds; longer than a tool's default since an agent may wait on a human. */
  agentRunTimeoutSeconds: number;
  /**
   * Sliding idle TTL (seconds) for conversation-session records — how long
   * a chat's active skill is remembered between turns (docs/adr/0012).
   */
  sessionTtlSeconds: number;
  /** Hard cap on stored conversation sessions; least-recently-updated evicted first (docs/adr/0012). */
  sessionMaxEntries: number;
  /**
   * HTTP port the callback receiver listens on for Job -> orchestrator
   * results. Deliberately separate from `httpPort` below so a NetworkPolicy
   * can expose them differently: this one only needs to be reachable from
   * Job pods in-cluster, never from outside callers (ADR 0006).
   */
  callbackPort: number;
  /** Base URL Jobs use to reach the callback receiver, e.g. a Service DNS name. */
  callbackBaseUrl: string;
  /** Shared secret for HMAC-signing/verifying callback bodies (used by this process itself to verify inbound callbacks). */
  callbackSecret: string;
  /**
   * Name of the k8s Secret containing the callback HMAC secret, referenced
   * (never copied as plaintext) by ToolRun CRs so the Go tool-controller can
   * wire it into the launched Job via `secretKeyRef` (ADR 0010).
   */
  callbackSecretRefName: string | undefined;
  /** Key within `callbackSecretRefName` holding the callback HMAC secret. */
  callbackSecretRefKey: string;
  /** HTTP port the consumer-facing invoke API listens on (ADR 0006). */
  httpPort: number;
  /**
   * Directory holding one `<runtime>.sock` per LocalTool executor sidecar
   * (ADR 0014), shared with the sidecars via an emptyDir. The orchestrator
   * POSTs run requests here over unix sockets — never over the network.
   */
  localToolSocketDir: string;
  /** Fallback per-execution timeout (seconds) for LocalTools that set none. */
  localToolTimeoutSeconds: number;
  /** JSON map of dev/test bearer tokens -> identity; see StaticIdentityResolver. */
  staticIdentities: string | undefined;
  /**
   * Redis connection URL for the session store (docs/adr/0016). When set, the
   * orchestrator uses a Redis-backed session store instead of the default
   * in-memory store, which allows multi-replica deployments and survives
   * restarts. When unset (the default), falls back to `InMemorySessionStore`
   * (single-replica only, same as before ADR 0016).
   */
  redisUrl: string | undefined;
  requestId: string;
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config: AppConfig = {
  namespace: process.env.AGENT_NAMESPACE ?? "default",
  crdGroup: process.env.AGENT_CRD_GROUP ?? "core.controller-agent.dev",
  crdVersion: process.env.AGENT_CRD_VERSION ?? "v1alpha1",
  natsUrl: process.env.AGENT_NATS_URL ?? "nats://localhost:4222",
  natsSubjectPrefix: process.env.AGENT_NATS_SUBJECT_PREFIX ?? "agent",
  qdrantUrl: process.env.AGENT_QDRANT_URL ?? "http://localhost:6333",
  qdrantApiKey: process.env.AGENT_QDRANT_API_KEY,
  qdrantCollection: process.env.AGENT_QDRANT_COLLECTION ?? "tools",
  qdrantVectorSize: num(process.env.AGENT_QDRANT_VECTOR_SIZE, 1536),
  skillsQdrantCollection: process.env.AGENT_QDRANT_SKILLS_COLLECTION ?? "skills",
  agentsQdrantCollection: process.env.AGENT_QDRANT_AGENTS_COLLECTION ?? "agents",
  embeddingModel: process.env.AGENT_EMBEDDING_MODEL ?? "text-embedding-3-small",
  selectionModel: process.env.AGENT_SELECTION_MODEL ?? "gpt-4o-2024-08-06",
  skillTopK: num(process.env.AGENT_SKILL_TOP_K, 3),
  agentTopK: num(process.env.AGENT_TOP_K, 3),
  agentRunTimeoutSeconds: num(process.env.AGENT_RUN_TIMEOUT_SECONDS, 1800),
  sessionTtlSeconds: num(process.env.AGENT_SESSION_TTL_SECONDS, 1800),
  sessionMaxEntries: num(process.env.AGENT_SESSION_MAX_ENTRIES, 1000),
  callbackPort: num(process.env.AGENT_CALLBACK_PORT, 8080),
  callbackBaseUrl: process.env.AGENT_CALLBACK_BASE_URL ?? "http://localhost:8080",
  httpPort: num(process.env.AGENT_HTTP_PORT, 8081),
  callbackSecret: process.env.AGENT_CALLBACK_SECRET ?? "",
  callbackSecretRefName: process.env.AGENT_CALLBACK_SECRET_REF_NAME,
  callbackSecretRefKey: process.env.AGENT_CALLBACK_SECRET_REF_KEY ?? "AGENT_CALLBACK_SECRET",
  localToolSocketDir: process.env.AGENT_LOCALTOOL_SOCKET_DIR ?? "/run/localtool",
  localToolTimeoutSeconds: num(process.env.AGENT_LOCALTOOL_TIMEOUT_SECONDS, 30),
  staticIdentities: process.env.AGENT_STATIC_IDENTITIES,
  redisUrl: process.env.AGENT_REDIS_URL,
  requestId: process.env.AGENT_REQUEST_ID ?? randomUUID(),
};
