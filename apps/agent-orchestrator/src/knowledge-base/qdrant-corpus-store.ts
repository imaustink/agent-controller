import type { CorpusChunk, CorpusQueryFilter, CorpusSearchResult, CorpusStore } from "./types.js";

export interface QdrantCorpusStoreConfig {
  url: string;
  apiKey?: string;
  /** One Connection's collection. A knowledge base fans out across several. */
  collection: string;
  fetchImpl?: typeof fetch;
}

/** Turns the query text into a vector, using the SAME model the corpus was built with. */
export interface CorpusEmbedder {
  embed(text: string): Promise<number[]>;
}

/**
 * Reads one Connection's corpus collection from Qdrant.
 *
 * The payload schema is not this file's to choose: these points are written by
 * the connection-broker and read by the Temporal engine's
 * `internal/vectorstore`, so the shape is fixed by both. `descriptor` is a JSON
 * STRING (not an object) holding the chunk — decoding it is the price of
 * matching a writer that must also satisfy a Go reader.
 *
 * PARITY: `Qdrant` in `engines/temporal/internal/vectorstore/qdrant.go`.
 * Both engines must return the same chunks for the same query and caller, or
 * one knowledge base answers differently depending on who served the turn.
 */
export class QdrantCorpusStore implements CorpusStore {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly cfg: QdrantCorpusStoreConfig,
    private readonly embedder: CorpusEmbedder,
  ) {
    this.base = cfg.url.replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  async query(text: string, filter: CorpusQueryFilter, k: number): Promise<CorpusSearchResult[]> {
    // Fail closed. An unresolved identity must not run an unfiltered search
    // (ADR 0004), and a corpus is client material — the one place where
    // answering "here is everything" would be worst.
    if (filter.callerRoles.length === 0) return [];
    if (k <= 0) return [];

    const response = await this.fetchImpl(
      `${this.base}/collections/${encodeURIComponent(this.cfg.collection)}/points/search`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.cfg.apiKey ? { "api-key": this.cfg.apiKey } : {}),
        },
        body: JSON.stringify({
          vector: await this.embedder.embed(text),
          limit: k,
          with_payload: true,
          filter: {
            should: [
              { key: "roles", match: { any: filter.callerRoles } },
              { key: "unrestricted", match: { value: true } },
            ],
            // Hidden points are referenceable but never discoverable. Nothing
            // writes a hidden corpus point today; the exclusion mirrors the Go
            // reader so the two cannot drift into disagreeing.
            must_not: [{ key: "hidden", match: { value: true } }],
          },
        }),
      },
    );

    if (response.status === 404) {
      // A collection that does not exist yet is an empty corpus, which is the
      // correct answer for a Connection that has not synced. Failing here would
      // take down the whole fan-out and its healthy siblings with it.
      return [];
    }
    if (!response.ok) {
      throw new Error(
        `qdrant search ${this.cfg.collection}: ${response.status} ${(await response.text()).slice(0, 300)}`,
      );
    }

    const body = (await response.json()) as {
      result?: { score: number; payload?: Record<string, unknown> | null }[];
    };

    return (body.result ?? []).flatMap((point) => {
      const chunk = decodeChunk(point.payload);
      // A point we cannot decode is skipped rather than surfaced half-built: a
      // chunk without provenance cannot be cited, and an uncited claim about a
      // client's material is not an acceptable answer.
      return chunk ? [{ chunk, score: point.score }] : [];
    });
  }
}

function decodeChunk(payload: Record<string, unknown> | null | undefined): CorpusChunk | undefined {
  if (!payload || typeof payload.descriptor !== "string") return undefined;
  try {
    const descriptor = JSON.parse(payload.descriptor) as CorpusChunk;
    if (!descriptor?.sourceUrl || !descriptor?.contentHash) return undefined;
    return descriptor;
  } catch {
    return undefined;
  }
}
