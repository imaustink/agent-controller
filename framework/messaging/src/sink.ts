import type { Event } from "./event.js";

/**
 * A transport for the tool-call event stream. Implementations decide how an
 * {@link Event} travels on the wire (stdout, a file, an HTTP callback, a
 * broker) but never alter the envelope. Sinks must preserve emission order.
 */
export interface Sink<TResult = unknown> {
  /** Deliver a single event. Should resolve once the event is durably handed off. */
  emit(event: Event<TResult>): Promise<void>;
  /** Flush and release any resources. Safe to call exactly once. */
  close(): Promise<void>;
}
