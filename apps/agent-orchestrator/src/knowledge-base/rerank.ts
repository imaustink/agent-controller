import type { AuthorizedChunk } from "./probe.js";

/**
 * Blended weights for ordering the authorized set before it is cut to the
 * answer's limit.
 *
 * Vector recall alone surfaces passages that are semantically near the question
 * but miss the exact terms the asker used — a client name, a system, an acronym
 * — and a passage that literally contains those terms is usually the better
 * citation. Blending keeps semantic recall while pulling term-exact passages up.
 * Deliberately NOT an external reranker model: the weights are fixed and the
 * sort is stable, so the same question returns the same order, with no new
 * dependency, secret, or per-query network cost.
 *
 * PARITY: `rerankWeightVector` / `rerankWeightKeyword` in
 * `engines/temporal/internal/corpus/rerank.go`.
 */
const WEIGHT_VECTOR = 0.7;
const WEIGHT_KEYWORD = 0.3;

/**
 * Reorders authorized chunks by a blend of normalized vector score and
 * query-keyword overlap, highest first, with a deterministic tie-break.
 *
 * It never adds or drops a chunk — only the order changes — so every access
 * guarantee the probe established still holds, and the caller's later
 * `slice(0, limit)` now keeps the most relevant `limit`, not merely the
 * highest-cosine ones.
 */
export function rerank(query: string, chunks: AuthorizedChunk[]): AuthorizedChunk[] {
  if (chunks.length < 2) return chunks;

  const terms = tokenize(query);

  // Min-max normalize vector scores across this set. Cosine scores are only
  // meaningful relative to one another, and a fixed scale would let one
  // component dominate purely because of its range.
  let min = Infinity;
  let max = -Infinity;
  for (const c of chunks) {
    if (c.score < min) min = c.score;
    if (c.score > max) max = c.score;
  }
  const span = max - min;

  const scored = chunks.map((chunk) => {
    const norm = span > 0 ? (chunk.score - min) / span : 1;
    const combined =
      WEIGHT_VECTOR * norm +
      WEIGHT_KEYWORD * keywordOverlap(terms, chunk.chunk.title ?? "", chunk.chunk.text);
    return { chunk, combined };
  });

  scored.sort((a, b) => {
    if (a.combined !== b.combined) return b.combined - a.combined;
    // Same blended score: fall back to the existing deterministic order, so a
    // tie never depends on probe-completion timing.
    if (a.chunk.score !== b.chunk.score) return b.chunk.score - a.chunk.score;
    if (a.chunk.chunk.connectionId !== b.chunk.chunk.connectionId) {
      return a.chunk.chunk.connectionId < b.chunk.chunk.connectionId ? -1 : 1;
    }
    if (a.chunk.chunk.sourceId !== b.chunk.chunk.sourceId) {
      return a.chunk.chunk.sourceId < b.chunk.chunk.sourceId ? -1 : 1;
    }
    return 0;
  });

  return scored.map((s) => s.chunk);
}

/** The fraction of distinct query terms that appear in the title or text, [0,1]. */
function keywordOverlap(terms: Set<string>, title: string, text: string): number {
  if (terms.size === 0) return 0;
  const haystack = tokenize(`${title} ${text}`);
  let hits = 0;
  for (const term of terms) if (haystack.has(term)) hits += 1;
  return hits / terms.size;
}

/**
 * Lowercases, splits on any non-alphanumeric character, drops tokens shorter
 * than three characters and a small set of common words, and returns the
 * distinct remainder. The stop list is deliberately tiny: it exists only to stop
 * "the"/"and" from making every chunk look equally relevant, not to do real
 * linguistic stemming.
 */
function tokenize(s: string): Set<string> {
  const out = new Set<string>();
  for (const token of s.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (token.length < 3 || STOP_WORDS.has(token)) continue;
    out.add(token);
  }
  return out;
}

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "what", "which", "with", "that", "this", "from",
  "have", "has", "can", "you", "our", "was", "were", "about", "into", "how",
  "does", "did", "they", "them",
]);
