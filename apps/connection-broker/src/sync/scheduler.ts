import type { ConnectionBinding } from "../registry.js";
import { syncConnection, type CorpusWriter, type ResourceSource, type SyncReport } from "./worker.js";

export interface SyncSchedulerOptions {
  source: ResourceSource;
  /**
   * A writer for one connection, not one shared writer.
   *
   * Every point carries its connection's allowedRoles, so a single writer would
   * stamp one connection's roles onto another's chunks — silently widening or
   * narrowing who can retrieve a whole client's material.
   */
  writerFor: (binding: ConnectionBinding) => CorpusWriter;
  /** Which connections to sync, and where each one's chunks go. */
  targets: () => { binding: ConnectionBinding; collection: string; intervalMs: number }[];
  onReport?: (report: SyncReport) => void;
  onError?: (connection: string, err: unknown) => void;
  now?: () => number;
}

/**
 * Runs each Connection's reconcile pass on its own interval.
 *
 * The reconcile IS the source of truth (ADR 0038 §4), not a backstop for
 * webhooks: Drive push channels expire, Slack drops events with no replay, and
 * a Confluence webhook can be disabled by a space admin. A corpus that is only
 * correct if no event was ever missed is a corpus nobody can trust.
 *
 * Passes never overlap for one connection. A pass that outruns its interval
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
  async onWebhook(connection: string, sourceIds: string[]): Promise<SyncReport | undefined> {
    return this.runOnce(connection, sourceIds.length > 0 ? sourceIds : undefined);
  }

  /**
   * Runs one pass now, outside the schedule. Returns undefined if one is
   * already running.
   *
   * `onlySourceIds` narrows it to a partial pass, which reconcile will not let
   * delete anything it did not examine.
   */
  async runOnce(connection: string, onlySourceIds?: string[]): Promise<SyncReport | undefined> {
    if (this.running.has(connection)) return undefined;
    const target = this.options.targets().find((candidate) => candidate.binding.name === connection);
    if (!target) return undefined;

    this.running.add(connection);
    try {
      const report = await syncConnection(
        this.options.source,
        this.options.writerFor(target.binding),
        {
          connection: target.binding.name,
          label: target.binding.name,
          collection: target.collection,
        },
        onlySourceIds ? { onlySourceIds } : {},
      );
      this.options.onReport?.(report);
      return report;
    } catch (err) {
      this.options.onError?.(connection, err);
      return undefined;
    } finally {
      this.running.delete(connection);
    }
  }

  private schedule(connection: string, delayMs: number): void {
    if (this.stopped) return;
    const timer = setTimeout(() => {
      void this.runOnce(connection).finally(() => {
        // Re-read the interval each time so a Connection edited mid-flight
        // takes effect without a restart, and a Connection that has gone away
        // stops rescheduling itself.
        const target = this.options.targets().find((candidate) => candidate.binding.name === connection);
        if (target) this.schedule(connection, target.intervalMs);
      });
    }, delayMs);
    this.timers.set(connection, timer);
  }
}
