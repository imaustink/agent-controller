import type { Chunk } from "./chunk.js";
import { corpusPointId } from "./point-id.js";
import type { CorpusWriter } from "./worker.js";
import type { IndexedChunk } from "./reconcile.js";

/** Turns chunk text into a vector. One call per batch, not per chunk. */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * The subset of the Qdrant client this writer needs, so the writer is testable
 * without a server and without pinning a client version into its tests.
 */
export interface QdrantLike {
  collectionExists(collection: string): Promise<boolean>;
  createCollection(collection: string, config: { vectors: { size: number; distance: "Cosine" } }): Promise<unknown>;
  upsert(collection: string, args: { wait: boolean; points: QdrantPoint[] }): Promise<unknown>;
  delete(collection: string, args: { wait: boolean; points: string[] }): Promise<unknown>;
  scroll(
    collection: string,
    args: { limit: number; offset?: string | number; with_payload: string[]; with_vector: false },
  ): Promise<{ points: { payload?: Record<string, unknown> | null }[]; next_page_offset?: string | number | null }>;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload: Record<string, unknown>;
}

export interface CorpusWriterConfig {
  /**
   * Roles a caller must hold to retrieve these chunks — the Connection's
   * `allowedRoles`, carried onto every point it contributes.
   *
   * Written per point rather than held per collection because a KnowledgeBase
   * mixes Connections of differing sensitivity into one search, so the filter
   * has to be evaluable on the point itself (ADR 0039 §4).
   */
  allowedRoles: string[];
  /** Must match the embedder's output dimensionality. */
  vectorSize: number;
}

/**
 * Writes a Connection's chunks into its Qdrant collection.
 *
 * **The payload schema here is not this file's to choose.** It is read by
 * `engines/temporal/internal/vectorstore/qdrant.go`, which is the only
 * implementation that currently reads corpus points, and which expects exactly
 * `{id, roles, unrestricted, hidden, descriptor}` with `descriptor` a JSON
 * STRING (not an object) decoding to `corpus.Chunk`. Every field below is
 * shaped by that reader rather than by what would be natural to write.
 *
 * A retrieval that returns a chunk the caller may not see is the failure this
 * whole design exists to prevent, so `unrestricted` is never set: a corpus
 * point is always role-gated, even when its Connection is broadly readable.
 * The permissive case is expressed by granting roles widely, not by opting out
 * of the filter.
 */
export class QdrantCorpusWriter implements CorpusWriter {
  constructor(
    private readonly client: QdrantLike,
    private readonly embedder: Embedder,
    private readonly cfg: CorpusWriterConfig,
  ) {}

  /**
   * Creates the collection if it is not there yet.
   *
   * Cosine distance and a shared vector size are what make scores from
   * different member collections comparable — a KnowledgeBase merges a fan-out
   * by score, which is meaningless if two corpora were built differently.
   */
  async ensureCollection(collection: string): Promise<void> {
    if (await this.client.collectionExists(collection)) return;
    await this.client.createCollection(collection, {
      vectors: { size: this.cfg.vectorSize, distance: "Cosine" },
    });
  }

  /**
   * Every chunk currently indexed for this connection.
   *
   * Reads the whole collection by design: reconcile compares this against what
   * the source just listed to decide what to delete, and a partial read would
   * present surviving chunks as absent — which, on a full pass, means deleting
   * them. Vectors are excluded because only the ids matter here and they are by
   * far the larger half of a point.
   */
  async indexed(collection: string): Promise<IndexedChunk[]> {
    // A collection that does not exist has nothing indexed, which is the true
    // answer rather than an error. It is also the state EVERY connection is in
    // on its first sync: syncConnection asks what is indexed before it writes
    // anything, so letting the 404 propagate means a new Connection can never
    // complete a first pass at all. Safe for reconcile, which cannot delete
    // what it was never told about.
    if (!(await this.client.collectionExists(collection))) return [];

    const out: IndexedChunk[] = [];
    let offset: string | number | undefined;

    do {
      const page = await this.client.scroll(collection, {
        limit: 256,
        offset,
        with_payload: ["id", "descriptor"],
        with_vector: false,
      });

      for (const point of page.points) {
        const indexed = toIndexedChunk(point.payload);
        // A point we cannot read provenance from is skipped rather than
        // guessed at. Treating it as absent would make a full reconcile delete
        // it, and treating it as present under a wrong id would strand it.
        if (indexed) out.push(indexed);
      }

      offset = page.next_page_offset ?? undefined;
    } while (offset !== undefined);

    return out;
  }

  async upsert(collection: string, chunks: Chunk[]): Promise<void> {
    // Qdrant rejects an empty update as a 400, and "nothing changed" is the
    // normal outcome of a reconcile over an unedited space.
    if (chunks.length === 0) return;
    await this.ensureCollection(collection);

    const vectors = await this.embedder.embed(chunks.map((chunk) => chunk.text));
    if (vectors.length !== chunks.length) {
      throw new Error(
        `embedder returned ${vectors.length} vectors for ${chunks.length} chunks; ` +
          `writing them would pair chunks with other chunks' embeddings`,
      );
    }

    await this.client.upsert(collection, {
      // Without this the next reconcile can read a stale view of what is
      // indexed and delete what it just wrote.
      wait: true,
      points: chunks.map((chunk, index) => ({
        id: corpusPointId(collection, chunk.contentHash),
        vector: vectors[index]!,
        payload: {
          id: chunk.contentHash,
          roles: this.cfg.allowedRoles,
          // Deliberately never true for a corpus point. See the class comment.
          unrestricted: false,
          hidden: false,
          descriptor: JSON.stringify(toDescriptor(chunk)),
        },
      })),
    });
  }

  async remove(collection: string, contentHashes: string[]): Promise<void> {
    if (contentHashes.length === 0) return;
    await this.client.delete(collection, {
      wait: true,
      points: contentHashes.map((hash) => corpusPointId(collection, hash)),
    });
  }
}

/**
 * The payload `descriptor`, matching `corpus.Chunk` in the Temporal engine.
 *
 * Built explicitly rather than by spreading the chunk: the two types are close
 * enough today that a spread would work and keep working right up until someone
 * adds a field to the TS chunk, at which point it silently starts writing a
 * shape the Go decoder ignores.
 */
function toDescriptor(chunk: Chunk): Record<string, unknown> {
  return {
    connectionId: chunk.connectionId,
    connectionLabel: chunk.connectionLabel,
    sourceUrl: chunk.sourceUrl,
    sourceId: chunk.sourceId,
    title: chunk.title,
    updatedAt: chunk.updatedAt,
    contentHash: chunk.contentHash,
    version: chunk.version,
    text: chunk.text,
    // The ACL mirror (ADR 0040). Written even though `corpus.Chunk` has no
    // field for it yet and the Go decoder will ignore it: the alternative is
    // discarding permission data the driver already paid an API call to
    // collect, and recovering it later means re-embedding every chunk in every
    // corpus. Unknown keys are free; a full re-index is not.
    //
    // It is mirror data, so it is a PRE-FILTER and never an authorization
    // decision — the probe is. Omitting it costs wasted probes; trusting it
    // would cost correctness.
    aclPrincipals: chunk.aclPrincipals,
    aclPermissive: chunk.aclPermissive,
  };
}

/** Recovers the (contentHash, sourceId) pair reconcile needs from a stored point. */
function toIndexedChunk(payload: Record<string, unknown> | null | undefined): IndexedChunk | undefined {
  if (!payload) return undefined;
  const contentHash = typeof payload.id === "string" ? payload.id : undefined;
  if (!contentHash) return undefined;

  // `descriptor` is a JSON string, not an object — that is the Go writer's
  // encoding, and reading it back is the price of matching it.
  let sourceId: string | undefined;
  try {
    const descriptor = typeof payload.descriptor === "string" ? JSON.parse(payload.descriptor) : undefined;
    if (descriptor && typeof descriptor.sourceId === "string") sourceId = descriptor.sourceId;
  } catch {
    // Unparseable descriptor: the point is still real and still owned by this
    // collection, so its id is reported. Reconcile keys deletion on the hash.
  }

  return { contentHash, sourceId: sourceId ?? "" };
}
