import { appendFileSync } from "node:fs";
import type { Event } from "./event.js";
import type { Sink } from "./sink.js";

/**
 * Appends each event as one NDJSON line to a file. Intended for a mounted
 * volume (or named pipe) so the parent can tail the stream and results survive
 * the container exiting — the simplest durable transport with no broker.
 *
 * Appends are synchronous to guarantee ordering and that a crash can't lose an
 * already-returned event.
 */
export class FileSink<TResult = unknown> implements Sink<TResult> {
  constructor(private readonly path: string) {}

  async emit(event: Event<TResult>): Promise<void> {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`);
  }

  async close(): Promise<void> {
    // Each write is flushed synchronously; nothing to release.
  }
}
