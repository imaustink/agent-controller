import type { NatsConnection } from "nats";
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
 * Both the connection AND the `nats` module itself are loaded on the first
 * {@link emit} call, so importing this package never loads a NATS client:
 * a tool on the `stdout`/`file`/`callback` transport, or anything using only
 * the protocol schemas, doesn't carry it (ADR 0047).
 */
export class NatsSink<TResult = unknown> implements Sink<TResult> {
  private nc: NatsConnection | undefined;
  private readonly encoder = new TextEncoder();

  constructor(private readonly opts: NatsSinkOptions) {}

  async emit(event: Event<TResult>): Promise<void> {
    if (!this.nc) {
      const { connect } = await import("nats");
      this.nc = await connect({ servers: this.opts.natsUrl });
    }
    // publish is fire-and-forget at the nats.js layer; the tool's
    // activeDeadlineSeconds (set by the core-controller) bounds the worst
    // case if the message is never received.
    this.nc.publish(this.opts.subject, this.encoder.encode(JSON.stringify(event)));
  }

  async close(): Promise<void> {
    if (!this.nc) return;
    await this.nc.drain();
    this.nc = undefined;
  }
}
