import { chunkDocument, type Chunk, type ChunkOptions } from "./chunk.js";
import { reconcile, type IndexedChunk, type ReconcileScope } from "./reconcile.js";
import type { Cursor, Document, ResourceRef } from "../drivers/types.js";

/**
 * Reads one Connection's resources. Implemented over the broker's HTTP API so
 * the third-party credential stays in the broker and the worker never holds
 * one — the worker is a client of the credential, not a holder of it.
 */
export interface ResourceSource {
  list(connection: string, cursor: Cursor): Promise<{ resources: ResourceRef[]; cursor: Cursor }>;
  fetch(connection: string, id: string): Promise<Document>;
}

/** The corpus side: what is already indexed, and where new points go. */
export interface CorpusWriter {
  /** Every chunk currently indexed for this connection. */
  indexed(collection: string): Promise<IndexedChunk[]>;
  upsert(collection: string, chunks: Chunk[]): Promise<void>;
  remove(collection: string, contentHashes: string[]): Promise<void>;
}

export interface SyncTarget {
  connection: string;
  label: string;
  collection: string;
  chunking?: ChunkOptions;
}

export interface SyncOptions {
  /**
   * Restricts the pass to specific resources — a webhook flush. Absent means a
   * full reconcile, which is the only kind allowed to delete freely
   * (see `reconcile`).
   */
  onlySourceIds?: string[];
  /** Guards against an unbounded walk if a driver's cursor never terminates. */
  maxPages?: number;
}

export interface SyncReport {
  connection: string;
  indexed: number;
  removed: number;
  unchanged: number;
  /** Resources that could not be fetched. Reported, never silently skipped. */
  failed: string[];
  full: boolean;
}

const DEFAULT_MAX_PAGES = 1_000;

/**
 * Runs one sync pass for one Connection.
 *
 * The pass is deliberately whole-corpus-aware even when it only fetched a few
 * resources: reconciliation needs to know which sources were examined before it
 * may delete anything (docs/adr/0038 §4's reconcile-is-the-source-of-truth
 * rule, and `reconcile`'s scope argument).
 *
 * A resource that cannot be fetched is reported rather than dropped. Silently
 * skipping it would let a corpus quietly shrink while every pass claimed
 * success — the class of failure the reconcile backstop exists to catch, so it
 * would be perverse for the backstop itself to hide it.
 */
export async function syncConnection(
  source: ResourceSource,
  corpus: CorpusWriter,
  target: SyncTarget,
  options: SyncOptions = {},
): Promise<SyncReport> {
  const full = options.onlySourceIds === undefined;
  const refs = full
    ? await walk(source, target.connection, options.maxPages ?? DEFAULT_MAX_PAGES)
    : options.onlySourceIds!.map((id) => ({ id }) as ResourceRef);

  const chunks: Chunk[] = [];
  const fetched: string[] = [];
  const failed: string[] = [];

  for (const ref of refs) {
    let document: Document;
    try {
      document = await source.fetch(target.connection, ref.id);
    } catch {
      // A resource we could not read tells us nothing about whether it still
      // exists, so it must not count as examined — otherwise reconciliation
      // would read the failure as a deletion.
      failed.push(ref.id);
      continue;
    }
    fetched.push(ref.id);
    chunks.push(
      ...chunkDocument({ id: target.connection, label: target.label }, document, target.chunking),
    );
  }

  // A full pass that could not read some resources is no longer a full pass.
  // Downgrading it is what stops a transient outage from deleting whatever it
  // failed to fetch.
  const scope: ReconcileScope =
    full && failed.length === 0 ? { kind: "full" } : { kind: "partial", sourceIds: fetched };

  const plan = reconcile(chunks, await corpus.indexed(target.collection), scope);

  if (plan.upsert.length > 0) await corpus.upsert(target.collection, plan.upsert);
  if (plan.remove.length > 0) await corpus.remove(target.collection, plan.remove);

  return {
    connection: target.connection,
    indexed: plan.upsert.length,
    removed: plan.remove.length,
    unchanged: plan.unchanged,
    failed,
    full: scope.kind === "full",
  };
}

/**
 * Walks a driver's pagination to completion.
 *
 * `maxPages` is a guard rather than a tuning knob: a driver whose cursor never
 * terminates would otherwise spin forever holding a credential, and the failure
 * would look like a hung Job rather than a bug.
 */
async function walk(source: ResourceSource, connection: string, maxPages: number): Promise<ResourceRef[]> {
  const refs: ResourceRef[] = [];
  let cursor: Cursor;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await source.list(connection, cursor);
    refs.push(...result.resources);
    if (!result.cursor) return refs;
    cursor = result.cursor;
  }
  throw new Error(`${connection} did not finish listing within ${maxPages} pages`);
}
