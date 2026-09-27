import type { CorpusBinding } from "../registry.js";
import { syncConnection, type CorpusWriter, type ResourceSource, type SyncReport } from "./worker.js";

export interface SyncSchedulerOptions {
  /**
   * A source for one connection, not one shared source.
   *
   * A source carries a sync token, and the broker scopes each sync token to
   * exactly one connection (see auth.ts): a source built with connection A's
   * token gets a 403 the moment it lists or fetches connection B, which fails
   * B's whole pass so B never indexes. One source per connection — carrying that
   * connection's own token — is the mirror of `writerFor` below, for the same
   * reason: the per-connection identity has to be honoured, not shared.
   */
  sourceFor: (binding: CorpusBinding) => ResourceSource;
  /**
   * A writer for one connection, not one shared writer.
   *
   * Every point carries its connection's allowedRoles, so a single writer would
   * stamp one connection's roles onto another's chunks — silently widening or
   * narrowing who can retrieve a whole client's material.
   */
  writerFor: (binding: CorpusBinding) => CorpusWriter;
  /** Which corpora to sync, and where each one's chunks go. */
  targets: () => { binding: CorpusBinding; collection: string; intervalMs: number }[];
  /**
   * Called for every completed pass, whatever triggered it. This is where a
   * Corpus's status is written back — see CorpusStatusWriter for why that
   * mattering is not obvious.
   */
  onReport?: (corpus: string, report: SyncReport) => void | Promise<void>;
  onError?: (corpus: string, err: unknown) => void;
  now?: () => number;
}

/**
 * Runs each Corpus's reconcile pass on its own interval.
 *
 * The reconcile IS the source of truth (ADR 0038 §4), not a backstop for
 * webhooks: Drive push channels expire, Slack drops events with no replay, and
 * a Confluence webhook can be disabled by a space admin. A corpus that is only
 * correct if no event was ever missed is a corpus nobody can trust.
 *
 * Passes never overlap for one corpus. A pass that outruns its interval
 * would otherwise start a second reconcile over the same corpus, and two
 * concurrent passes can each conclude the other's freshly written chunks are
 * absent — which, on a full pass, means deleting them.
 */
export class SyncScheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(private readonly options: SyncSchedulerOptions) {}

  start(): void {
    this.stopped = false;
    for (const target of this.options.targets()) {
      this.schedule(target.binding.name, 0);
    }
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Runs a pass for specific resources, in response to a provider webhook.
   *
   * A webhook can only ever ADD work, never authorize a deletion: an empty
   * sourceIds means "something changed, we do not know what", which escalates
   * to a full pass rather than doing nothing — because a deletion that never
   * sent an event would otherwise never be noticed, and a corpus that is
   * correct only if no event was missed is one nobody can trust (ADR 0038 §4).
   */
  async onWebhook(corpus: string, sourceIds: string[]): Promise<SyncReport | undefined> {
    return this.runOnce(corpus, sourceIds.length > 0 ? sourceIds : undefined);
  }

  /**
   * Runs one pass now, outside the schedule. Returns undefined if one is
   * already running.
   *
   * `onlySourceIds` narrows it to a partial pass, which reconcile will not let
   * delete anything it did not examine.
   */
  async runOnce(corpus: string, onlySourceIds?: string[]): Promise<SyncReport | undefined> {
    if (this.running.has(corpus)) return undefined;
    const target = this.options.targets().find((candidate) => candidate.binding.name === corpus);
    if (!target) return undefined;

    this.running.add(corpus);
    try {
      const report = await syncConnection(
        this.options.sourceFor(target.binding),
        this.options.writerFor(target.binding),
        {
          connection: target.binding.name,
          label: target.binding.name,
          collection: target.collection,
        },
        onlySourceIds ? { onlySourceIds } : {},
      );
      await this.options.onReport?.(corpus, report);
      return report;
    } catch (err) {
      this.options.onError?.(corpus, err);
      return undefined;
    } finally {
      this.running.delete(corpus);
    }
  }

  private schedule(corpus: string, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.runOnce(corpus).finally(() => {
        // Re-read the interval each time so a Corpus edited mid-flight takes
        // effect without a restart, and a Corpus that has gone away stops
        // rescheduling itself.
        const target = this.options.targets().find((candidate) => candidate.binding.name === corpus);
        if (target) this.schedule(corpus, target.intervalMs);
      });
    }, delayMs);
    this.timers.set(corpus, timer);
  }
}
