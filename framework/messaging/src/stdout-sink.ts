import type { Event } from "./event.js";
import type { Sink } from "./sink.js";

/**
 * Writes events to stdout. Two modes:
 *
 * - `"final"` (legacy/back-compat): stdout carries ONLY the final result
 *   payload (pretty JSON) from a `succeeded` event. Intermediate events are
 *   dropped from stdout so the data channel stays clean.
 * - `"ndjson"`: every event is written as one newline-delimited JSON object.
 *
 * In both modes stdout is reserved for structured output; diagnostic logging
 * belongs on stderr.
 */
export class StdoutSink<TResult = unknown> implements Sink<TResult> {
  constructor(private readonly mode: "final" | "ndjson" = "final") {}

  async emit(event: Event<TResult>): Promise<void> {
    if (this.mode === "ndjson") {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    // Legacy final mode: only the successful result reaches stdout.
    if (event.type === "succeeded") {
      process.stdout.write(`${JSON.stringify(event.result, null, 2)}\n`);
    }
  }

  async close(): Promise<void> {
    // stdout is owned by the process; nothing to release.
  }
}
