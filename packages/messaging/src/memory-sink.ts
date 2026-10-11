import { EventSchema, type Event } from "./event.js";
import type { Sink } from "./sink.js";

/**
 * In-process {@link Sink}: keeps every event in {@link events} and hands each
 * one to an optional listener, so a tool's emitter can run with no transport
 * at all -- in tests, or embedded in another process.
 *
 * Each event makes a real JSON round trip and is validated against the wire
 * schema first, so an event that a receiver would reject on the wire is
 * rejected here too (by throwing from {@link emit}).
 */
export class MemorySink<TResult = unknown> implements Sink<TResult> {
  readonly events: Event<TResult>[] = [];
  private closed = false;

  constructor(private readonly onEvent?: (event: Event<TResult>) => void) {}

  async emit(event: Event<TResult>): Promise<void> {
    if (this.closed) throw new Error("MemorySink is closed");
    const wire: unknown = JSON.parse(JSON.stringify(event));
    const parsed = EventSchema.safeParse(wire);
    if (!parsed.success) {
      throw new Error(`event violates the wire contract: ${parsed.error.message}`);
    }
    const received = wire as Event<TResult>;
    this.events.push(received);
    this.onEvent?.(received);
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
