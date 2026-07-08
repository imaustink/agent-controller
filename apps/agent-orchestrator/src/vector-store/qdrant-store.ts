import { QdrantClient } from "@qdrant/js-client-rest";
import type { JobTemplate, ToolDescriptor } from "../tool-descriptor.js";
import { toQdrantPointId } from "./qdrant-id.js";
import type { Embedder, ToolQueryFilter, ToolSearchResult, VectorStore } from "./types.js";

export interface QdrantToolStoreConfig {
  url: string;
  apiKey?: string;
  /** Collection name; created on first {@link QdrantToolStore.ensureCollection} call if missing. */
  collection: string;
  /** Must match the embedder's output dimensionality. */
  vectorSize: number;
}

interface ToolPayload {
  /**
   * Original domain id (e.g. the k8s Deployment name). Qdrant's own point id
   * is a derived UUID (see qdrant-id.ts) since it rejects arbitrary strings,
   * so this is the source of truth callers get back.
   */
  id: string;
  name: string;
  description: string;
  allowedRoles: string[];
  jobTemplate: JobTemplate;
  tier: string | null;
}

/**
 * {@link VectorStore} adapter backed by Qdrant (ADR 0003). This is the ONLY
 * module in the orchestrator allowed to import the Qdrant client directly —
 * everything else depends on the {@link VectorStore} port.
 */
export class QdrantToolStore implements VectorStore {
  private readonly client: QdrantClient;

  constructor(
    private readonly cfg: QdrantToolStoreConfig,
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

  async upsert(tools: ToolDescriptor[]): Promise<void> {
    // Qdrant rejects an upsert with zero points as 400 "Empty update
    // request" -- a no-op is the correct behavior here (e.g. zero tool
    // Deployments discovered yet), not a startup failure.
    if (tools.length === 0) return;
    const points = await Promise.all(
      tools.map(async (tool) => ({
        // Qdrant's native point id must be an unsigned integer or a UUID --
        // arbitrary strings (e.g. a Deployment name) are rejected with a 400.
        // Derive a stable UUID and keep the real id in the payload instead.
        id: toQdrantPointId(tool.id),
        vector: await this.embedder.embed(tool.description),
        payload: {
          id: tool.id,
          name: tool.name,
          description: tool.description,
          allowedRoles: tool.allowedRoles,
          jobTemplate: tool.jobTemplate,
          tier: tool.tier ?? null,
        } satisfies ToolPayload,
      })),
    );
    await this.client.upsert(this.cfg.collection, { points, wait: true });
  }

  async query(text: string, filter: ToolQueryFilter, k = 5): Promise<ToolSearchResult[]> {
    // Fail closed: no roles resolved -> no candidate tools, ever (ADR 0004).
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
    return results.map((point) => {
      const payload = point.payload as unknown as ToolPayload;
      const tool: ToolDescriptor = {
        id: payload.id,
        name: payload.name,
        description: payload.description,
        allowedRoles: payload.allowedRoles,
        jobTemplate: payload.jobTemplate,
        tier: payload.tier ?? undefined,
      };
      return { tool, score: point.score };
    });
  }

  async getByIds(ids: string[], filter: ToolQueryFilter): Promise<ToolSearchResult[]> {
    // Fail closed, same as `query` (ADR 0004).
    if (filter.callerRoles.length === 0 || ids.length === 0) {
      return [];
    }
    const points = await this.client.retrieve(this.cfg.collection, {
      ids: ids.map(toQdrantPointId),
      with_payload: true,
    });
    const results: ToolSearchResult[] = [];
    for (const point of points) {
      const payload = point.payload as unknown as ToolPayload | undefined;
      if (!payload) continue;
      if (!payload.allowedRoles.some((role) => filter.callerRoles.includes(role))) continue;
      const tool: ToolDescriptor = {
        id: payload.id,
        name: payload.name,
        description: payload.description,
        allowedRoles: payload.allowedRoles,
        jobTemplate: payload.jobTemplate,
        tier: payload.tier ?? undefined,
      };
      results.push({ tool, score: 1 });
    }
    return results;
  }

  async delete(ids: string[]): Promise<void> {
    await this.client.delete(this.cfg.collection, { points: ids.map(toQdrantPointId), wait: true });
  }
}
