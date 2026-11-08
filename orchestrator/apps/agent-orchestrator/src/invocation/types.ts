import type { InvocationRecord } from "../server.js";

/**
 * Where `/invoke`'s accept-then-poll records live (docs/adr/0006).
 *
 * Extracted from the in-process `Map` this used to be, for a failure that is
 * routine rather than exotic: a pod that accepts `POST /invoke` must
 * personally survive to answer `GET /invoke/:id`, because the record only ever
 * existed in its own memory. A rollout therefore loses every turn accepted in
 * the seconds around it -- the AgentRun runs to completion and Succeeds, and
 * its answer has nowhere to go, because the replacement pod 404s the poll.
 * Observed directly: an AgentRun created at 04:48:30 against a pod whose
 * replacement started at 04:48:32, and a gateway comment reading
 * `poll failed: 404`.
 *
 * The same property also means `/invoke` cannot be scaled past one replica at
 * all -- a second replica would 404 whichever polls it happened to receive.
 * Durable records fix both.
 *
 * NOT a correctness-critical store in the way the AgentRun CR is: the CR is
 * the record of the work, this is the record of the *request*. Losing it costs
 * a caller its answer, not the work.
 */
export interface InvocationStore {
  get(id: string): Promise<InvocationRecord | undefined>;
  set(id: string, record: InvocationRecord): Promise<void>;
}

/**
 * The previous behaviour, kept as the default so a deployment without Redis
 * runs exactly as it did before -- single replica, records lost on restart.
 */
export class InMemoryInvocationStore implements InvocationStore {
  private readonly records = new Map<string, InvocationRecord>();

  async get(id: string): Promise<InvocationRecord | undefined> {
    return this.records.get(id);
  }

  async set(id: string, record: InvocationRecord): Promise<void> {
    this.records.set(id, record);
  }
}
