import type { Chunk } from "./chunk.js";

/** One chunk already in the corpus, as the store reports it. */
export interface IndexedChunk {
  contentHash: string;
  sourceId: string;
}

/**
 * Which resources this pass actually looked at.
 *
 * This is the field that decides whether deletion is safe, and getting it wrong
 * empties a corpus. A full reconcile walked everything, so anything indexed and
 * absent is genuinely gone. A webhook-triggered pass looked at a handful of
 * resources, so everything ELSE is indexed-and-absent too — and deleting on
 * that basis would wipe the corpus down to whichever pages happened to change
 * in the last minute.
 *
 * Hence deletion is scoped to the source ids a partial pass actually fetched.
 */
export type ReconcileScope = { kind: "full" } | { kind: "partial"; sourceIds: string[] };

export interface ReconcilePlan {
  /** New or changed chunks, which are the only ones that cost an embedding. */
  upsert: Chunk[];
  /** Point ids to remove. */
  remove: string[];
  /** Already present and identical — the measure of how cheap this pass was. */
  unchanged: number;
}

/**
 * Works out what a sync pass should write.
 *
 * Point ids are content hashes (docs/adr/0039 §7), so the comparison is a set
 * difference and "has this chunk changed?" needs no stored state beyond the ids
 * already in the corpus. That is what makes an incremental re-sync cheap: a
 * document nobody edited costs one fetch and zero embeddings.
 */
export function reconcile(
  current: Chunk[],
  indexed: IndexedChunk[],
  scope: ReconcileScope,
): ReconcilePlan {
  const indexedHashes = new Set(indexed.map((chunk) => chunk.contentHash));

  const upsert: Chunk[] = [];
  let unchanged = 0;
  const seen = new Set<string>();

  for (const chunk of current) {
    // A document can legitimately contain the same passage twice; it is one
    // point, and writing it twice in a pass would be a wasted embedding.
    if (seen.has(chunk.contentHash)) continue;
    seen.add(chunk.contentHash);

    if (indexedHashes.has(chunk.contentHash)) unchanged += 1;
    else upsert.push(chunk);
  }

  const inScope = deletionScope(scope);
  const remove = indexed
    .filter((chunk) => inScope(chunk.sourceId) && !seen.has(chunk.contentHash))
    .map((chunk) => chunk.contentHash);

  return { upsert, remove, unchanged };
}

/**
 * Whether an already-indexed chunk's source was examined this pass, and so
 * whether its absence means anything.
 */
function deletionScope(scope: ReconcileScope): (sourceId: string) => boolean {
  if (scope.kind === "full") return () => true;
  const touched = new Set(scope.sourceIds);
  return (sourceId) => touched.has(sourceId);
}
