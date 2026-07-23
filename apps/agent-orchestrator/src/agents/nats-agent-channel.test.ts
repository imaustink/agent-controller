import { describe, expect, it } from "vitest";
import { JSONCodec } from "nats";
import { NatsAgentChannel } from "./nats-agent-channel.js";

/**
 * Minimal in-memory stand-in for the subset of `nats.NatsConnection` this
 * module uses (`subscribe`/`publish`) — enough to drive `NatsAgentChannel`'s
 * subject-keyed pub/sub without a real NATS server. `NatsAgentChannel`'s
 * constructor is `private` at the type level only; esbuild (vitest's
 * transform) doesn't enforce it at runtime, so it's constructed directly here
 * via a type cast.
 */
class FakeNatsConnection {
  private readonly subscribers = new Map<string, Set<(data: Uint8Array) => void>>();

  publish(subject: string, data: Uint8Array): void {
    for (const cb of this.subscribers.get(subject) ?? []) cb(data);
  }

  subscribe(subject: string): { [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }>; unsubscribe(): void } {
    const queue: Uint8Array[] = [];
    let resolveNext: ((v: IteratorResult<{ data: Uint8Array }>) => void) | undefined;
    let stopped = false;

    const cb = (data: Uint8Array) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        r({ value: { data }, done: false });
      } else {
        queue.push(data);
      }
    };
    let set = this.subscribers.get(subject);
    if (!set) {
      set = new Set();
      this.subscribers.set(subject, set);
    }
    set.add(cb);

    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<{ data: Uint8Array }>> {
            if (stopped) return Promise.resolve({ value: undefined, done: true });
            if (queue.length > 0) return Promise.resolve({ value: { data: queue.shift()! }, done: false });
            return new Promise((resolve) => {
              resolveNext = resolve;
            });
          },
        };
      },
      unsubscribe() {
        stopped = true;
        set!.delete(cb);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = undefined;
          r({ value: undefined, done: true });
        }
      },
    };
  }
}

function makeChannel(): { channel: NatsAgentChannel; nc: FakeNatsConnection } {
  const nc = new FakeNatsConnection();
  const ChannelCtor = NatsAgentChannel as unknown as new (nc: unknown, subjectPrefix: string) => NatsAgentChannel;
  return { channel: new ChannelCtor(nc, "agent"), nc };
}

function publishUp(nc: FakeNatsConnection, runId: string, msg: Record<string, unknown>): void {
  const codec = JSONCodec<unknown>();
  nc.publish(`agent.${runId}.up`, codec.encode({ agent_run_id: runId, seq: 0, ts: "2026-07-13T00:00:00.000Z", ...msg }));
}

describe("NatsAgentChannel", () => {
  it("invokes onToolCall for a tool_call up-message without resolving the awaitReply promise", async () => {
    const { channel, nc } = makeChannel();
    const calls: { callId: string; tool: string; input: string }[] = [];

    const awaitReply = channel.awaitReply("run-1", { onToolCall: (call) => calls.push(call) });

    publishUp(nc, "run-1", { type: "tool_call", callId: "call-1", tool: "kubectl-readonly", input: "get pods" });
    // Give the async iterator a tick to consume the message before the final reply.
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ callId: "call-1", tool: "kubectl-readonly", input: "get pods" }]);

    publishUp(nc, "run-1", { type: "reply", message: "done", final: true });
    const result = await awaitReply;
    expect(result).toMatchObject({ message: "done", final: true });
  });

  it("resolveToolCall publishes a correlated tool_result down-message", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const received: unknown[] = [];
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) received.push(codec.decode(m.data));
    })();

    await channel.resolveToolCall("run-1", "call-1", { ok: true, result: { pods: [] } });
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([
      expect.objectContaining({ type: "tool_result", callId: "call-1", ok: true, result: { pods: [] } }),
    ]);
  });

  it("resolveToolCall publishes an error outcome", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const received: unknown[] = [];
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) received.push(codec.decode(m.data));
    })();

    await channel.resolveToolCall("run-1", "call-2", { ok: false, error: "not declared in toolRefs" });
    await new Promise((r) => setTimeout(r, 0));

    expect(received).toEqual([
      expect.objectContaining({ type: "tool_result", callId: "call-2", ok: false, error: "not declared in toolRefs" }),
    ]);
  });
});
