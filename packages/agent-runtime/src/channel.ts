import { connect, JSONCodec, type NatsConnection, type Subscription } from "nats";
import {
  AgentDownMessageSchema,
  agentSubjects,
  type AgentDownMessage,
  type AgentUpMessage,
} from "@controller-agent/messaging";
import type { AgentRuntimeConfig } from "./config.js";

/**
 * Transport-agnostic two-way channel for one agent run. The runtime depends on
 * this interface (not NATS directly) so tests can inject a fake; {@link NatsChannel}
 * is the production implementation.
 */
export interface AgentChannel {
  /** Publish an up-message (agent -> orchestrator). */
  publishUp(msg: AgentUpMessage): Promise<void>;
  /** Register the handler invoked for each validated down-message (orchestrator -> agent). */
  onDown(handler: (msg: AgentDownMessage) => void): void;
  /** Flush outstanding publishes, then close the connection. */
  close(): Promise<void>;
}

/** NATS-backed {@link AgentChannel}: publishes on the up subject, subscribes to the down subject. */
export class NatsChannel implements AgentChannel {
  private readonly codec = JSONCodec<unknown>();
  private downHandler: ((msg: AgentDownMessage) => void) | undefined;

  private constructor(
    private readonly nc: NatsConnection,
    private readonly upSubject: string,
    sub: Subscription,
  ) {
    void this.consume(sub);
  }

  static async connect(config: AgentRuntimeConfig): Promise<NatsChannel> {
    const { up, down } = agentSubjects(config.runId, config.subjectPrefix);
    const nc = await connect({ servers: config.natsUrl });
    const sub = nc.subscribe(down);
    return new NatsChannel(nc, up, sub);
  }

  publishUp(msg: AgentUpMessage): Promise<void> {
    this.nc.publish(this.upSubject, this.codec.encode(msg));
    return Promise.resolve();
  }

  onDown(handler: (msg: AgentDownMessage) => void): void {
    this.downHandler = handler;
  }

  async close(): Promise<void> {
    await this.nc.drain();
  }

  private async consume(sub: Subscription): Promise<void> {
    for await (const m of sub) {
      let decoded: unknown;
      try {
        decoded = this.codec.decode(m.data);
      } catch {
        continue; // ignore non-JSON garbage on the subject
      }
      const parsed = AgentDownMessageSchema.safeParse(decoded);
      // Drop messages that don't match the protocol rather than crashing the
      // agent loop on a malformed control message.
      if (parsed.success) this.downHandler?.(parsed.data);
    }
  }
}
