import { connect, JSONCodec, type NatsConnection } from "nats";
import type { Event } from "./event.js";
import type { Sink } from "./sink.js";

export interface NatsSinkOptions {
  /** NATS server URL, e.g. nats://nats.controller-agent.svc.cluster.local:4222 */
  natsUrl: string;
  /** Subject to publish events to, e.g. callbacks.<jobId> */
  subject: string;
}

/**
 * NATS-backed {@link Sink}: publishes each event as JSON to a fixed subject.
 * Used when RECIPE_TRANSPORT=nats — the orchestrator subscribes to the same
 * subject via NatsJobReceiver, replacing the HTTP callback protocol for
 * container tools (docs/adr/0016).
 *
 * No HMAC signing: the subject is a UUID-derived capability (only the
 * tool that received it via RECIPE_NATS_SUBJECT can publish to it), and the
 * NATS server provides transport-level security. This removes the need to
 * share a callback HMAC secret between the orchestrator and every tool Job.
 *
 * The connection is lazily established on the first {@link emit} call so
 * tool containers that use the `stdout` or `file` transport are not forced
 * to carry a NATS client import cost.
 */
export class NatsSink<TResult = unknown> implements Sink<TResult> {
  private nc: NatsConnection | undefined;
  private readonly codec = JSONCodec<Event>();

  constructor(private readonly opts: NatsSinkOptions) {}

  async emit(event: Event<TResult>): Promise<void> {
    if (!this.nc) {
      this.nc = await connect({ servers: this.opts.natsUrl });
    }
    // publish is fire-and-forget at the nats.js layer; the tool's
    // activeDeadlineSeconds (set by the core-controller) bounds the worst
    // case if the message is never received.
    this.nc.publish(this.opts.subject, this.codec.encode(event as Event));
  }

  async close(): Promise<void> {
    if (!this.nc) return;
    await this.nc.drain();
    this.nc = undefined;
  }
}
