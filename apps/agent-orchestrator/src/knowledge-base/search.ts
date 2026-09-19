import type { CorpusSearchResult, CorpusStore } from "./types.js";

export interface CorpusSearchOutcome {
  hits: CorpusSearchResult[];
  /**
   * Member collections that could not be consulted. Returned rather than
   * swallowed so an answer can say part of the knowledge base was missed —
   * distinct from `withheld` in `visibleConnections`, which counts sources this
   * caller may not read.
   */
  skipped: number;
}

/**
 * Fans out across a knowledge base's member collections and merges the results
 * (docs/adr/0039 §1).
 *
 * Queries run in parallel: a knowledge base of eight members should cost one
 * round trip's latency, not eight. Scores are directly comparable because every
 * corpus shares one embedder and cosine distance, which is what makes merging
 * by score meaningful rather than approximate.
 *
 * Partial failure degrades rather than fails — one unreachable collection must
 * not take a whole knowledge base down with it. But if EVERY member fails, that
 * is a broken search, and reporting "nothing found" would be a confident lie
 * about the client's material, so it throws.
 *
 * PARITY: `corpus.Search` in `engines/temporal/internal/corpus/corpus.go`.
 */
export async function searchCorpus(
  stores: CorpusStore[],
  query: string,
  callerRoles: string[],
  limit: number,
): Promise<CorpusSearchOutcome> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`corpus search limit must be a positive integer, got ${limit}`);
  }
  if (stores.length === 0) return { hits: [], skipped: 0 };

  // Each member is asked for `limit` on the assumption that one of them could
  // supply the whole answer; the prune below cuts back to `limit` overall.
  const settled = await Promise.allSettled(
    stores.map((store) => store.query(query, { callerRoles }, limit)),
  );

  const gathered: CorpusSearchResult[] = [];
  let skipped = 0;
  let firstError: unknown;

  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      skipped += 1;
      firstError ??= outcome.reason;
      continue;
    }
    gathered.push(...outcome.value);
  }

  if (skipped === stores.length) {
    throw new Error(`every corpus in this knowledge base failed: ${String(firstError)}`);
  }

  return { hits: prune(gathered, limit), skipped };
}

/**
 * De-duplicates by content hash and returns the best `limit` hits.
 *
 * The same passage can legitimately arrive twice — a document in a Drive folder
 * that is also linked into a synced Confluence space. Keeping both would spend
 * the answer's budget saying one thing twice, and would make a cited answer
 * list two URLs for one fact.
 *
 * Ties break deterministically (higher score, then connection id, then source
 * id) rather than by arrival order: a parallel fan-out has no meaningful
 * "first", and a stable order means the same question twice does not produce
 * two differently-cited answers.
 */
function prune(hits: CorpusSearchResult[], limit: number): CorpusSearchResult[] {
  const best = new Map<string, CorpusSearchResult>();

  for (const hit of hits) {
    // No hash to dedupe on: fall back to source identity so an unhashed chunk
    // is not silently dropped.
    const key = hit.chunk.contentHash || `${hit.chunk.connectionId}\u0000${hit.chunk.sourceId}`;
    const existing = best.get(key);
    if (!existing || betterThan(hit, existing)) best.set(key, hit);
  }

  return [...best.values()].sort((a, b) => (betterThan(a, b) ? -1 : betterThan(b, a) ? 1 : 0))
    .slice(0, limit);
}

function betterThan(a: CorpusSearchResult, b: CorpusSearchResult): boolean {
  if (a.score !== b.score) return a.score > b.score;
  if (a.chunk.connectionId !== b.chunk.connectionId) {
    return a.chunk.connectionId < b.chunk.connectionId;
  }
  return a.chunk.sourceId < b.chunk.sourceId;
}
