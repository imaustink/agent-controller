import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";
import { EventSchema, type Event } from "@controller-agent/messaging";
import type { JobResultReceiver, ProgressHandler } from "./receiver.js";

type PendingJob = {
  resolve: (event: Event) => void;
  reject: (err: Error) => void;
};

/**
 * NATS-backed result-channel adapter (replaces the HTTP `CallbackReceiver`
 * when `AGENT_NATS_URL` is configured). Subscribes once to a wildcard subject
 * `<prefix>.*` and dispatches incoming events to the right pending caller by
 * jobId extracted from the subject's last token.
 *
 * Subject scheme: `<prefix>.<jobId>` (e.g. `callbacks.550e8400-...`).
 * The orchestrator generates the jobId and passes it to the tool via
 * `ToolRun.spec.callback.natsSubject`; the tool publishes on that exact
 * subject via `NatsSink`.
 *
 * No HMAC verification: the subject itself is a UUID-derived capability
 * (only the tool that received it via RECIPE_NATS_SUBJECT can publish to it).
 * The NATS server provides transport security; callers should configure
 * appropriate NATS auth/TLS for their deployment.
 */
export class NatsJobReceiver implements JobResultReceiver {
  private readonly codec = JSONCodec<unknown>();
  private readonly pending = new Map<string, PendingJob>();
  private readonly progressHandlers = new Map<string, ProgressHandler>();
  private sub: Subscription | undefined;

  private constructor(
    private readonly nc: NatsConnection,
    private readonly prefix: string,
  ) {}

  /**
   * Connects to NATS and subscribes to `<prefix>.*`. Call once at startup
   * before any `awaitJob` / `onJobProgress` calls. Returns the ready
   * receiver.
   */
  static async connect(natsUrl: string, prefix = "callbacks"): Promise<NatsJobReceiver> {
    const nc = await connect({ servers: natsUrl });
    const receiver = new NatsJobReceiver(nc, prefix);
    receiver.sub = nc.subscribe(`${prefix}.*`);
    void receiver.consume(receiver.sub);
    return receiver;
  }

  awaitJob(jobId: string): Promise<Event> {
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
    });
  }

  onJobProgress(jobId: string, handler: ProgressHandler): () => void {
    this.progressHandlers.set(jobId, handler);
    return () => {
      this.progressHandlers.delete(jobId);
    };
  }

  async close(): Promise<void> {
    this.sub?.unsubscribe();
    await this.nc.drain();
  }

  private async consume(sub: Subscription): Promise<void> {
    for await (const m of sub) {
      // Extract jobId from `<prefix>.<jobId>`.
      const jobId = m.subject.slice(this.prefix.length + 1);
      if (!jobId) continue;

      let decoded: unknown;
      try {
        decoded = this.codec.decode(m.data);
      } catch {
        continue; // ignore non-JSON messages
      }

      const parsed = EventSchema.safeParse(decoded);
      if (!parsed.success) continue;
      const event = parsed.data as Event;

      if (event.type === "succeeded" || event.type === "failed") {
        const pending = this.pending.get(jobId);
        if (pending) {
          this.pending.delete(jobId);
          this.progressHandlers.delete(jobId);
          pending.resolve(event);
        }
      } else if (event.type === "progress" || event.type === "warning") {
        const handler = this.progressHandlers.get(jobId);
        if (handler) {
          if (event.type === "progress") {
            handler(event.stage, event.message);
          } else {
            handler("warning", event.message);
          }
        }
      }
    }
  }
}
