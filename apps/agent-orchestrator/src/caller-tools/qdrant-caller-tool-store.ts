import { QdrantClient } from "@qdrant/js-client-rest";
import { toQdrantPointId } from "../vector-store/qdrant-id.js";
import type { Embedder } from "../vector-store/types.js";
import type { CallerToolDescriptor, CallerToolStore } from "./types.js";

export interface QdrantCallerToolStoreConfig {
  url: string;
  apiKey?: string;
  /**
   * Collection name — deliberately NOT the tools/skills/agents collection
   * (docs/adr/0035 §2). Keeping caller definitions out of the catalog index is
   * what makes this feature unable to affect catalog recall or latency by
   * construction rather than by discipline.
   */
  collection: string;
  /** Must match the embedder's output dimensionality. */
  vectorSize: number;
}

interface CallerToolPayload {
  /** Content hash — the real id (the Qdrant point id is a UUID derived from it). */
  hash: string;
  name: string;
  description: string;
  parametersJson: string;
  /** Epoch ms of the last request that referenced this definition; drives {@link QdrantCallerToolStore.prune}. */
  lastSeenAt: number;
}

/**
 * {@link CallerToolStore} backed by Qdrant (docs/adr/0035 §2), mirroring
 * ../vector-store/qdrant-store.ts. The point id is a UUID derived from the
 * definition's CONTENT HASH rather than from a caller/session id, which is what
 * turns the collection into an embedding cache: an identical definition is
 * embedded once, ever, across all callers and all turns. Since a client resends
 * the same tool array every turn, steady-state embedding cost is zero.
 *
 * `search` is always restricted to hashes the current request itself supplied,
 * so it cannot surface another caller's definition even though the collection is
 * a shared namespace. That id-restriction — not an RBAC payload filter — is the
 * isolation boundary here; see {@link CallerToolStore} for why no RBAC applies.
 */
export class QdrantCallerToolStore implements CallerToolStore {
  private readonly client: QdrantClient;

  constructor(
    private readonly cfg: QdrantCallerToolStoreConfig,
    private readonly embedder: Embedder,
    /** Injectable for tests; defaults to a real client built from `cfg`. */
    client?: QdrantClient,
    /** Injectable clock, so prune/lastSeenAt are testable without faking timers. */
    private readonly now: () => number = () => Date.now(),
  ) {
    this.client = client ?? new QdrantClient({ url: cfg.url, apiKey: cfg.apiKey });
  }

  /** Idempotent; call once at startup before the first index/search. */
  async ensureCollection(): Promise<void> {
    const { collections } = await this.client.getCollections();
    const exists = collections.some((c) => c.name === this.cfg.collection);
    if (!exists) {
      await this.client.createCollection(this.cfg.collection, {
        vectors: { size: this.cfg.vectorSize, distance: "Cosine" },
      });
    }
  }

  /**
   * Embeds and upserts only definitions not already present, and refreshes
   * `lastSeenAt` on the rest. The `retrieve`-then-embed-the-misses shape is the
   * cache lookup: on a warm collection this is one Qdrant round trip and zero
   * embedding calls.
   */
  async index(tools: CallerToolDescriptor[]): Promise<void> {
    if (tools.length === 0) return;
    const known = await this.retrieveKnown(tools);
    const timestamp = this.now();

    const misses = tools.filter((tool) => !known.has(tool.hash));
    const points = await Promise.all(
      misses.map(async (tool) => ({
        id: toQdrantPointId(tool.hash),
        vector: await this.embedder.embed(embedText(tool)),
        payload: {
          hash: tool.hash,
          name: tool.name,
          description: tool.description,
          parametersJson: tool.parametersJson,
          lastSeenAt: timestamp,
        } satisfies CallerToolPayload,
      })),
    );
    if (points.length > 0) {
      // `wait: true` because the very next thing this turn does is search for
      // these exact ids — an eventually-consistent write would make a
      // first-sight tool invisible on the turn that introduced it.
      await this.client.upsert(this.cfg.collection, { points, wait: true });
    }

    // Touch the cache hits so an actively-used definition never ages out from
    // under a live conversation. Payload-only update: no re-embedding.
    const hits = tools.filter((tool) => known.has(tool.hash));
    if (hits.length > 0) {
      await this.client.setPayload(this.cfg.collection, {
        payload: { lastSeenAt: timestamp },
        points: hits.map((tool) => toQdrantPointId(tool.hash)),
        wait: false,
      });
    }
  }

  async search(text: string, tools: CallerToolDescriptor[], k: number): Promise<CallerToolDescriptor[]> {
    if (tools.length === 0 || k <= 0) return [];
    const byHash = new Map(tools.map((tool) => [tool.hash, tool]));
    const vector = await this.embedder.embed(text);
    const results = await this.client.search(this.cfg.collection, {
      vector,
      limit: Math.min(k, tools.length),
      // The id allowlist IS the isolation boundary: every id comes from the
      // request body being served, so retrieval can never range beyond the
      // definitions this caller just supplied (docs/adr/0035 §2).
      filter: { must: [{ has_id: tools.map((tool) => toQdrantPointId(tool.hash)) }] },
    });
    const selected: CallerToolDescriptor[] = [];
    for (const point of results) {
      const payload = point.payload as unknown as CallerToolPayload | undefined;
      // Resolve back to the REQUEST's own descriptor, not the payload's. The
      // payload is a cache entry that any caller may have written; the request
      // body is what this turn is actually serving, and the two are only
      // guaranteed to agree because the hash covers every field.
      const tool = payload ? byHash.get(payload.hash) : undefined;
      if (tool) selected.push(tool);
    }
    return selected;
  }

  async prune(olderThanMs: number): Promise<number> {
    const cutoff = this.now() - olderThanMs;
    const result = await this.client.delete(this.cfg.collection, {
      filter: { must: [{ key: "lastSeenAt", range: { lt: cutoff } }] },
      wait: true,
    });
    // Qdrant's delete-by-filter response doesn't report a count; the operation
    // id is all there is, so callers get "did it run", not "how many".
    return result?.status === "completed" ? 1 : 0;
  }

  /** Which of `tools` are already indexed, by hash. */
  private async retrieveKnown(tools: CallerToolDescriptor[]): Promise<Set<string>> {
    const points = await this.client.retrieve(this.cfg.collection, {
      ids: tools.map((tool) => toQdrantPointId(tool.hash)),
      with_payload: true,
    });
    const known = new Set<string>();
    for (const point of points) {
      const payload = point.payload as unknown as CallerToolPayload | undefined;
      if (payload?.hash) known.add(payload.hash);
    }
    return known;
  }
}

/**
 * Text embedded for a caller tool. Name is included alongside the description
 * because a caller tool's description is often terse or empty (`parameters` is
 * where clients put their detail), and the name alone frequently carries the
 * whole signal — e.g. `search_confluence` with no description at all.
 */
function embedText(tool: CallerToolDescriptor): string {
  return tool.description ? `${tool.name}: ${tool.description}` : tool.name;
}
