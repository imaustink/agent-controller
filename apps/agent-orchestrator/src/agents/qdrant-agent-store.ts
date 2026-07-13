import { QdrantClient } from "@qdrant/js-client-rest";
import { toQdrantPointId } from "../vector-store/qdrant-id.js";
import type { Embedder } from "../vector-store/types.js";
import type { AgentDescriptor, AgentQueryFilter, AgentSearchResult, AgentStore } from "./types.js";

export interface QdrantAgentStoreConfig {
  url: string;
  apiKey?: string;
  /** Collection name; created on first {@link QdrantAgentStore.ensureCollection} call if missing. */
  collection: string;
  /** Must match the embedder's output dimensionality. */
  vectorSize: number;
}

interface AgentPayload {
  /**
   * Original domain id (the Agent CR name). Qdrant's own point id is a
   * derived UUID (see ../vector-store/qdrant-id.ts) since it rejects
   * arbitrary strings, so this is the source of truth callers get back.
   */
  id: string;
  name: string;
  description: string;
  allowedRoles: string[];
  tier: string | null;
  orchestratorPrompt: string | null;
  namespace: string;
  agentRef: string;
}

/**
 * {@link AgentStore} adapter backed by Qdrant — mirrors
 * ../vector-store/qdrant-store.ts (Tool) exactly, in a separate collection
 * from both tools and skills. This is the only module allowed to import the
 * Qdrant client directly for agents.
 */
export class QdrantAgentStore implements AgentStore {
  private readonly client: QdrantClient;

  constructor(
    private readonly cfg: QdrantAgentStoreConfig,
    private readonly embedder: Embedder,
    /** Injectable for tests; defaults to a real client built from `cfg`. */
    client?: QdrantClient,
  ) {
    this.client = client ?? new QdrantClient({ url: cfg.url, apiKey: cfg.apiKey });
  }

  /** Idempotent; call once at startup before the first upsert/query. */
  async ensureCollection(): Promise<void> {
    const { collections } = await this.client.getCollections();
    const exists = collections.some((c) => c.name === this.cfg.collection);
    if (!exists) {
      await this.client.createCollection(this.cfg.collection, {
        vectors: { size: this.cfg.vectorSize, distance: "Cosine" },
      });
    }
  }

  async upsert(agents: AgentDescriptor[]): Promise<void> {
    // Qdrant rejects an upsert with zero points as 400 "Empty update
    // request" -- a no-op is the correct behavior here (e.g. zero Agent CRs
    // registered yet), not a startup failure.
    if (agents.length === 0) return;
    const points = await Promise.all(
      agents.map(async (agent) => ({
        id: toQdrantPointId(agent.id),
        vector: await this.embedder.embed(agent.description),
        payload: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          allowedRoles: agent.allowedRoles,
          tier: agent.tier ?? null,
          orchestratorPrompt: agent.orchestratorPrompt ?? null,
          namespace: agent.agentRunTemplate.namespace,
          agentRef: agent.agentRunTemplate.agentRef,
        } satisfies AgentPayload,
      })),
    );
    await this.client.upsert(this.cfg.collection, { points, wait: true });
  }

  async query(text: string, filter: AgentQueryFilter, k = 5): Promise<AgentSearchResult[]> {
    // Fail closed: no roles resolved -> no candidate agents, ever.
    if (filter.callerRoles.length === 0) {
      return [];
    }
    const vector = await this.embedder.embed(text);
    const results = await this.client.search(this.cfg.collection, {
      vector,
      limit: k,
      filter: {
        must: [{ key: "allowedRoles", match: { any: filter.callerRoles } }],
      },
    });
    return results.map((point) => ({ agent: toAgentDescriptor(point.payload as unknown as AgentPayload), score: point.score }));
  }

  async getByIds(ids: string[], filter: AgentQueryFilter): Promise<AgentSearchResult[]> {
    // Fail closed, same as `query`.
    if (filter.callerRoles.length === 0 || ids.length === 0) {
      return [];
    }
    const points = await this.client.retrieve(this.cfg.collection, {
      ids: ids.map(toQdrantPointId),
      with_payload: true,
    });
    const results: AgentSearchResult[] = [];
    for (const point of points) {
      const payload = point.payload as unknown as AgentPayload | undefined;
      if (!payload) continue;
      if (!payload.allowedRoles.some((role) => filter.callerRoles.includes(role))) continue;
      results.push({ agent: toAgentDescriptor(payload), score: 1 });
    }
    return results;
  }

  async delete(ids: string[]): Promise<void> {
    await this.client.delete(this.cfg.collection, { points: ids.map(toQdrantPointId), wait: true });
  }
}

function toAgentDescriptor(payload: AgentPayload): AgentDescriptor {
  return {
    id: payload.id,
    name: payload.name,
    description: payload.description,
    allowedRoles: payload.allowedRoles,
    tier: payload.tier ?? undefined,
    orchestratorPrompt: payload.orchestratorPrompt ?? undefined,
    agentRunTemplate: { namespace: payload.namespace, agentRef: payload.agentRef },
  };
}
