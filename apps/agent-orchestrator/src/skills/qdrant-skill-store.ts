import { QdrantClient } from "@qdrant/js-client-rest";
import { toQdrantPointId } from "../vector-store/qdrant-id.js";
import type { Embedder } from "../vector-store/types.js";
import type { SkillAccess, SkillDescriptor, SkillQueryFilter, SkillSearchResult, SkillStore } from "./types.js";

export interface QdrantSkillStoreConfig {
  url: string;
  apiKey?: string;
  /** Collection name; created on first {@link QdrantSkillStore.ensureCollection} call if missing. */
  collection: string;
  /** Must match the embedder's output dimensionality. */
  vectorSize: number;
}

interface SkillPayload {
  /**
   * Original domain id (e.g. "recipe-publisher-skill"). Qdrant's own point
   * id is a derived UUID (see ../vector-store/qdrant-id.ts) since it rejects
   * arbitrary strings, so this is the source of truth callers get back.
   */
  id: string;
  name: string;
  description: string;
  markdown: string;
  toolIds: string[];
  /** Agent ids this skill may delegate to directly (ADR 0021). */
  agentIds: string[];
  /**
   * Derived retrieval audience (docs/adr/0011, extended to agents by ADR
   * 0021): intersection of the referenced tools'/agents' allowedRoles,
   * computed at index time by derive-access.ts — skills carry no
   * allowedRoles of their own.
   */
  effectiveRoles: string[];
  /** True for skills with no toolIds/agentIds — retrievable by any resolved identity. */
  unrestricted: boolean;
}

/**
 * {@link SkillStore} adapter backed by Qdrant (docs/adr/0008, mirrors
 * ../vector-store/qdrant-store.ts / ADR 0003). This is the only module
 * allowed to import the Qdrant client directly for skills — everything else
 * depends on the {@link SkillStore} port.
 */
export class QdrantSkillStore implements SkillStore {
  private readonly client: QdrantClient;

  constructor(
    private readonly cfg: QdrantSkillStoreConfig,
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

  async upsert(skills: SkillAccess[]): Promise<void> {
    // Same Qdrant behavior as qdrant-store.ts's upsert: an empty points
    // array is a 400, not a no-op, on Qdrant's side -- guard it here.
    if (skills.length === 0) return;
    const points = await Promise.all(
      skills.map(async ({ skill, effectiveRoles }) => ({
        // Qdrant's native point id must be an unsigned integer or a UUID --
        // arbitrary strings (e.g. "recipe-publisher-skill") are rejected
        // with a 400. Derive a stable UUID and keep the real id in payload.
        id: toQdrantPointId(skill.id),
        vector: await this.embedder.embed(skill.description),
        payload: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          markdown: skill.markdown,
          toolIds: skill.toolIds,
          agentIds: skill.agentIds,
          effectiveRoles: effectiveRoles ?? [],
          unrestricted: effectiveRoles === null,
        } satisfies SkillPayload,
      })),
    );
    await this.client.upsert(this.cfg.collection, { points, wait: true });
  }

  async query(text: string, filter: SkillQueryFilter, k = 5): Promise<SkillSearchResult[]> {
    // Fail closed: no roles resolved -> no candidate skills, ever.
    if (filter.callerRoles.length === 0) {
      return [];
    }
    const vector = await this.embedder.embed(text);
    const results = await this.client.search(this.cfg.collection, {
      vector,
      limit: k,
      // `should` clauses are OR'd (≥1 must match): a skill is a candidate if
      // it is unrestricted (no toolIds) OR its derived effectiveRoles
      // intersect the caller's roles (docs/adr/0011).
      filter: {
        should: [
          { key: "unrestricted", match: { value: true } },
          { key: "effectiveRoles", match: { any: filter.callerRoles } },
        ],
      },
    });
    return results.map((point) => {
      const payload = point.payload as unknown as SkillPayload;
      const skill: SkillDescriptor = {
        id: payload.id,
        name: payload.name,
        description: payload.description,
        markdown: payload.markdown,
        toolIds: payload.toolIds,
        agentIds: payload.agentIds,
      };
      return { skill, score: point.score };
    });
  }

  async delete(ids: string[]): Promise<void> {
    await this.client.delete(this.cfg.collection, { points: ids.map(toQdrantPointId), wait: true });
  }

  async getByIds(ids: string[], filter: SkillQueryFilter): Promise<SkillDescriptor[]> {
    // Fail closed, same as `query` (docs/adr/0011): no roles -> nothing,
    // even for unrestricted skills.
    if (filter.callerRoles.length === 0 || ids.length === 0) {
      return [];
    }
    const points = await this.client.retrieve(this.cfg.collection, {
      ids: ids.map(toQdrantPointId),
      with_payload: true,
    });
    const skills: SkillDescriptor[] = [];
    for (const point of points) {
      const payload = point.payload as unknown as SkillPayload | undefined;
      if (!payload) continue;
      // Same audience rule as `query`'s filter: unrestricted OR derived
      // effectiveRoles intersect the caller's roles.
      if (!payload.unrestricted && !payload.effectiveRoles.some((role) => filter.callerRoles.includes(role))) {
        continue;
      }
      skills.push({
        id: payload.id,
        name: payload.name,
        description: payload.description,
        markdown: payload.markdown,
        toolIds: payload.toolIds,
        agentIds: payload.agentIds,
      });
    }
    return skills;
  }
}
