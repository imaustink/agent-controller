import { PatchStrategy, setHeaderOptions } from "@kubernetes/client-node";

import type { SyncReport } from "./sync/worker.js";

/** The slice of the custom-objects API needed to patch a status subresource. */
export interface StatusPatcherApi {
  patchNamespacedCustomObjectStatus(
    args: {
      group: string;
      version: string;
      namespace: string;
      plural: string;
      name: string;
      body: unknown;
    },
    options?: unknown,
  ): Promise<unknown>;
}

/**
 * A merge patch, said explicitly.
 *
 * The client defaults this endpoint to `application/json-patch+json`, which
 * expects an ARRAY of operations. Sending `{ status: {...} }` under that type
 * is rejected by the API server with
 * `cannot unmarshal object into Go value of type []handlers.jsonPatchOp` — a
 * 400 this writer catches and reports, so every sync succeeded and silently
 * never recorded that it had. A Corpus showed no `lastSyncTime` however many
 * times it synced, which reads as "the sync never ran".
 *
 * It has to go through `setHeaderOptions`. The second parameter is
 * `ConfigurationOptions`, which is middleware and server config — a bare
 * `{ headers }` object type-checks against it and is silently ignored, which
 * is how the first attempt at this fix looked exactly like the bug.
 */
const MERGE_PATCH = setHeaderOptions("Content-Type", PatchStrategy.MergePatch);

export interface CorpusStatusWriterOptions {
  api: StatusPatcherApi;
  namespace: string;
  group: string;
  version: string;
  plural: string;
  now?: () => Date;
  onError?: (corpus: string, err: unknown) => void;
}

/**
 * Publishes what a sync pass did back onto the Corpus.
 *
 * Without this the numbers exist and nobody sees them. `syncConnection` returns
 * a report with exactly these fields and used to drop it on the floor, while
 * the KnowledgeBase controller read `lastReconcileTime` to decide whether a
 * member was stale — and `corpusIsStale` treats "syncs but has never
 * reconciled" as stale by definition. So every syncing Corpus reported stale
 * forever, and every answer hedged about freshness it could not actually
 * measure.
 *
 * A failure to write is REPORTED, never fatal. The pass already happened and
 * the chunks are already indexed; failing the sync because its bookkeeping did
 * not land would throw away real work to protect a timestamp.
 */
export class CorpusStatusWriter {
  constructor(private readonly options: CorpusStatusWriterOptions) {}

  /**
   * Records a completed pass.
   *
   * `lastSyncTime` moves on ANY pass — a webhook-triggered partial one counts,
   * because material did arrive. `lastReconcileTime` moves only on a FULL pass,
   * because that is the one that could have noticed a deletion, and staleness
   * is a question about what we might have missed rather than about how
   * recently something arrived (ADR 0038 §4).
   */
  async record(corpus: string, report: SyncReport): Promise<void> {
    const at = (this.options.now?.() ?? new Date()).toISOString();

    const status: Record<string, unknown> = {
      resources: report.indexed + report.unchanged,
      lastSyncTime: at,
    };
    if (report.full) status.lastReconcileTime = at;

    try {
      await this.options.api.patchNamespacedCustomObjectStatus(
        {
          group: this.options.group,
          version: this.options.version,
          namespace: this.options.namespace,
          plural: this.options.plural,
          name: corpus,
          body: { status },
        },
        MERGE_PATCH,
      );
    } catch (err) {
      this.options.onError?.(corpus, err);
    }
  }
}
