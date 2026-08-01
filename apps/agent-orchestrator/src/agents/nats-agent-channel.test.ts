import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JSONCodec } from "nats";
import {
  AgentTurnFailedError,
  AgentTurnTimeoutError,
  AgentTurnTransportError,
  NatsAgentChannel,
} from "./nats-agent-channel.js";

/**
 * Minimal in-memory stand-in for the subset of `nats.NatsConnection` this
 * module uses (`subscribe`/`publish`) — enough to drive `NatsAgentChannel`'s
 * subject-keyed pub/sub without a real NATS server. Injected via the
 * `NatsAgentChannel.forTest()` factory, which bypasses the `.connect()` dial
 * without poking a hole in the `private constructor` invariant.
 *
 * `closeAll`/`failAll` model the two ways a subscription dies underneath an
 * in-flight `awaitReply` — a drained/closed connection and a connection-level
 * error — which the wait logic must report as transport loss rather than as a
 * timeout.
 */
class FakeNatsConnection {
  private readonly subscribers = new Map<string, Set<(data: Uint8Array) => void>>();
  /** Live subscription handles, so a test can kill them from the outside. */
  private readonly controls = new Set<{ stop(): void; fail(err: Error): void }>();

  publish(subject: string, data: Uint8Array): void {
    for (const cb of this.subscribers.get(subject) ?? []) cb(data);
  }

  subscribe(subject: string): { [Symbol.asyncIterator](): AsyncIterator<{ data: Uint8Array }>; unsubscribe(): void } {
    const queue: Uint8Array[] = [];
    let resolveNext: ((v: IteratorResult<{ data: Uint8Array }>) => void) | undefined;
    let rejectNext: ((err: Error) => void) | undefined;
    let stopped = false;
    let failure: Error | undefined;

    const cb = (data: Uint8Array) => {
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        rejectNext = undefined;
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

    const stop = () => {
      stopped = true;
      set!.delete(cb);
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = undefined;
        rejectNext = undefined;
        r({ value: undefined, done: true });
      }
    };
    const fail = (err: Error) => {
      failure = err;
      set!.delete(cb);
      if (rejectNext) {
        const r = rejectNext;
        resolveNext = undefined;
        rejectNext = undefined;
        r(err);
      }
    };
    const control = { stop, fail };
    this.controls.add(control);

    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<{ data: Uint8Array }>> {
            if (queue.length > 0) return Promise.resolve({ value: { data: queue.shift()! }, done: false });
            if (failure) return Promise.reject(failure);
            if (stopped) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => {
              resolveNext = resolve;
              rejectNext = reject;
            });
          },
        };
      },
      unsubscribe() {
        self.controls.delete(control);
        stop();
      },
    };
  }

  /** Every subscription ends cleanly, as when the connection is drained/closed. */
  closeAll(): void {
    for (const c of this.controls) c.stop();
    this.controls.clear();
  }

  /** Every subscription rejects, as on a connection-level NATS error. */
  failAll(err: Error): void {
    for (const c of this.controls) c.fail(err);
    this.controls.clear();
  }
}

function makeChannel(): { channel: NatsAgentChannel; nc: FakeNatsConnection } {
  const nc = new FakeNatsConnection();
  // `forTest` takes a real `NatsConnection`; the fake implements only the
  // subset this module touches (`subscribe`/`publish`), hence the cast on the
  // argument (not around the private constructor).
  const channel = NatsAgentChannel.forTest(nc as unknown as Parameters<typeof NatsAgentChannel.forTest>[0], "agent");
  return { channel, nc };
}

function publishUp(nc: FakeNatsConnection, runId: string, msg: Record<string, unknown>): void {
  const codec = JSONCodec<unknown>();
  nc.publish(`agent.${runId}.up`, codec.encode({ agent_run_id: runId, seq: 0, ts: "2026-07-13T00:00:00.000Z", ...msg }));
}

describe("NatsAgentChannel", () => {
  it("invokes onToolCall for a tool_call up-message without resolving the awaitReply promise", async () => {
    const { channel, nc } = makeChannel();
    const seen: Array<{ callId: string; tool: string; input: string }> = [];
    let settled = false;
    const pending = channel.awaitReply("run-1", { onToolCall: (c) => seen.push(c) }).then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setImmediate(r));

    publishUp(nc, "run-1", { type: "tool_call", callId: "c1", tool: "web-search", input: '{"q":"x"}' });
    await new Promise((r) => setImmediate(r));

    expect(seen).toEqual([{ callId: "c1", tool: "web-search", input: '{"q":"x"}' }]);
    expect(settled).toBe(false);

    publishUp(nc, "run-1", { type: "reply", message: "done", final: true });
    await expect(pending).resolves.toMatchObject({ message: "done" });
  });

  it("resolveToolCall publishes a correlated tool_result down-message", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const down: unknown[] = [];
    nc.subscribe("agent.run-1.down");
    // Capture by subscribing a raw listener on the down subject.
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) down.push(codec.decode(m.data));
    })();

    await channel.resolveToolCall("run-1", "c1", { ok: true, result: { hits: 3 } });
    await new Promise((r) => setImmediate(r));

    expect(down).toEqual([
      expect.objectContaining({ type: "tool_result", callId: "c1", ok: true, result: { hits: 3 } }),
    ]);
    sub.unsubscribe();
  });

  it("resolveToolCall publishes an error outcome", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const down: unknown[] = [];
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) down.push(codec.decode(m.data));
    })();

    await channel.resolveToolCall("run-1", "c1", { ok: false, error: "tool exploded" });
    await new Promise((r) => setImmediate(r));

    expect(down).toEqual([expect.objectContaining({ type: "tool_result", callId: "c1", ok: false, error: "tool exploded" })]);
    sub.unsubscribe();
  });

  /**
   * The orchestrator's half of surviving its own disappearance: the agent holds
   * its concluding message until this ack lands, so failing to send one would
   * leave every finished run re-offering an answer nobody ever confirmed.
   */
  it("acks a reply on the down subject, quoting that message's seq", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const down: unknown[] = [];
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) down.push(codec.decode(m.data));
    })();

    const pending = channel.awaitReply("run-1");
    await new Promise((r) => setImmediate(r));
    const codecUp = JSONCodec<unknown>();
    nc.publish(
      "agent.run-1.up",
      codecUp.encode({ agent_run_id: "run-1", seq: 7, ts: "2026-07-13T00:00:00.000Z", type: "reply", message: "done", final: true }),
    );

    await expect(pending).resolves.toMatchObject({ message: "done" });
    expect(down).toEqual([expect.objectContaining({ type: "reply_ack", ackSeq: 7 })]);
    sub.unsubscribe();
  });

  it("acks a failed message too, so a failure is not re-offered forever", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const down: unknown[] = [];
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) down.push(codec.decode(m.data));
    })();

    const pending = channel.awaitReply("run-1");
    await new Promise((r) => setImmediate(r));
    nc.publish(
      "agent.run-1.up",
      JSONCodec<unknown>().encode({
        agent_run_id: "run-1",
        seq: 3,
        ts: "2026-07-13T00:00:00.000Z",
        type: "failed",
        code: "agent_error",
        message: "boom",
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(AgentTurnFailedError);
    expect(down).toEqual([expect.objectContaining({ type: "reply_ack", ackSeq: 3 })]);
    sub.unsubscribe();
  });

  it("acks a non-final reply (a question) as well", async () => {
    const { channel, nc } = makeChannel();
    const codec = JSONCodec<unknown>();
    const down: unknown[] = [];
    const sub = nc.subscribe("agent.run-1.down");
    void (async () => {
      for await (const m of sub) down.push(codec.decode(m.data));
    })();

    const pending = channel.awaitReply("run-1");
    await new Promise((r) => setImmediate(r));
    nc.publish(
      "agent.run-1.up",
      JSONCodec<unknown>().encode({
        agent_run_id: "run-1",
        seq: 2,
        ts: "2026-07-13T00:00:00.000Z",
        type: "reply",
        message: "Which branch?",
        final: false,
      }),
    );

    await expect(pending).resolves.toMatchObject({ final: false });
    expect(down).toEqual([expect.objectContaining({ type: "reply_ack", ackSeq: 2 })]);
    sub.unsubscribe();
  });
});

/**
 * The wait's timing semantics. These are unit-level; the same behaviours are
 * also exercised against a real nats.js client and a real socket in
 * nats-agent-channel.integration.test.ts, because the production defect lived
 * in library behaviour a fake connection cannot reproduce.
 */
describe("NatsAgentChannel.awaitReply timing", () => {
  const RUN = "run-1";
  const IDLE_MS = 10 * 60 * 1000;
  /** Lets the awaitReply read loop advance before we assert. */
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults the idle window to 10 minutes when the caller passes none", async () => {
    const { channel, nc } = makeChannel();
    const settled = channel.awaitReply(RUN).catch((err: unknown) => err);
    await flush();

    publishUp(nc, RUN, { type: "progress", message: "Running coding agent…" });
    await flush();
    // Just shy of the window, measured from the last message.
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    publishUp(nc, RUN, { type: "progress", message: "still going" });
    await flush();
    await vi.advanceTimersByTimeAsync(IDLE_MS);

    const err = await settled;
    expect(err).toBeInstanceOf(AgentTurnTimeoutError);
    expect((err as Error).message).toMatch(/went silent for 600000ms/);
  });

  it("does not give up on a run that keeps narrating, however long it takes", async () => {
    const { channel, nc } = makeChannel();
    const settled = channel
      .awaitReply(RUN, { idleTimeoutMs: IDLE_MS })
      .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }));
    await flush();

    // Eight hours of work, narrating every 9 minutes — each gap just inside the
    // 10-minute window, and the total far beyond any bound on duration.
    for (let i = 0; i < 53; i++) {
      await vi.advanceTimersByTimeAsync(9 * 60 * 1000);
      publishUp(nc, RUN, { type: "progress", message: `step ${i}` });
      await flush();
    }
    publishUp(nc, RUN, { type: "reply", message: "done", final: true });

    const outcome = await settled;
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.r).toMatchObject({ message: "done", final: true });
    expect(outcome.ok && outcome.r.narration).toHaveLength(53);
  });

  it("resets the idle window on undecodable traffic too", async () => {
    const { channel, nc } = makeChannel();
    const pending = channel.awaitReply(RUN, { idleTimeoutMs: IDLE_MS });
    await flush();

    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    nc.publish(`agent.${RUN}.up`, new TextEncoder().encode("not json"));
    await flush();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    publishUp(nc, RUN, { type: "reply", message: "done", final: true });

    await expect(pending).resolves.toMatchObject({ message: "done" });
  });

  it("pauses the idle clock while a tool_call is outstanding (docs/adr/0028)", async () => {
    const { channel, nc } = makeChannel();
    const pending = channel.awaitReply(RUN, { idleTimeoutMs: IDLE_MS });
    await flush();

    publishUp(nc, RUN, { type: "tool_call", callId: "c1", tool: "slow-build", input: "{}" });
    await flush();

    // A container tool far outlasting the idle window. The agent is silent
    // because it is blocked on us, so this must NOT be read as a dead agent.
    await vi.advanceTimersByTimeAsync(IDLE_MS * 5);
    await flush();

    await channel.resolveToolCall(RUN, "c1", { ok: true, result: "built" });
    await flush();
    publishUp(nc, RUN, { type: "reply", message: "done", final: true });

    await expect(pending).resolves.toMatchObject({ message: "done" });
  });

  it("resumes the idle clock once the last outstanding tool_call is answered", async () => {
    const { channel, nc } = makeChannel();
    const settled = channel.awaitReply(RUN, { idleTimeoutMs: IDLE_MS }).catch((err: unknown) => err);
    await flush();

    publishUp(nc, RUN, { type: "tool_call", callId: "c1", tool: "a", input: "{}" });
    publishUp(nc, RUN, { type: "tool_call", callId: "c2", tool: "b", input: "{}" });
    await flush();

    await channel.resolveToolCall(RUN, "c1", { ok: true });
    await flush();
    // One call still outstanding — clock stays paused.
    await vi.advanceTimersByTimeAsync(IDLE_MS * 2);
    await flush();

    await channel.resolveToolCall(RUN, "c2", { ok: true });
    await flush();
    // Now nothing is owed, so silence counts again.
    await vi.advanceTimersByTimeAsync(IDLE_MS);

    const err = await settled;
    expect(err).toBeInstanceOf(AgentTurnTimeoutError);
  });

  it("reports a closed subscription as a transport error, not a timeout", async () => {
    const { channel, nc } = makeChannel();
    const settled = channel.awaitReply(RUN, { idleTimeoutMs: IDLE_MS }).catch((err: unknown) => err);
    await flush();

    nc.closeAll();

    const err = await settled;
    expect(err).toBeInstanceOf(AgentTurnTransportError);
    expect(err).not.toBeInstanceOf(AgentTurnTimeoutError);
    expect((err as Error).message).toMatch(/may still be in progress/);
  });

  it("reports a connection-level error as a transport error, not a timeout", async () => {
    const { channel, nc } = makeChannel();
    const settled = channel.awaitReply(RUN, { idleTimeoutMs: IDLE_MS }).catch((err: unknown) => err);
    await flush();

    nc.failAll(new Error("CONNECTION_CLOSED"));

    const err = await settled;
    expect(err).toBeInstanceOf(AgentTurnTransportError);
    expect((err as Error).message).toMatch(/CONNECTION_CLOSED/);
  });

  it("still surfaces an agent-reported failure as AgentTurnFailedError", async () => {
    const { channel, nc } = makeChannel();
    const settled = channel.awaitReply(RUN, { idleTimeoutMs: IDLE_MS }).catch((err: unknown) => err);
    await flush();

    publishUp(nc, RUN, { type: "failed", code: "claude_auth_expired", message: "credential expired" });

    expect(await settled).toBeInstanceOf(AgentTurnFailedError);
  });

  it("collects narration and streams it to onProgress", async () => {
    const { channel, nc } = makeChannel();
    const seen: Array<[string | undefined, string]> = [];
    const pending = channel.awaitReply(RUN, {
      idleTimeoutMs: IDLE_MS,
      onProgress: (stage, message) => seen.push([stage, message]),
    });
    await flush();

    publishUp(nc, RUN, { type: "ready" });
    publishUp(nc, RUN, { type: "progress", message: "cloning repo", stage: "clone" });
    publishUp(nc, RUN, { type: "warning", message: "shallow" });
    publishUp(nc, RUN, { type: "reply", message: "done", final: true });

    const result = await pending;
    expect(result.narration).toEqual(["cloning repo", "Warning: shallow"]);
    expect(seen).toEqual([
      ["clone", "cloning repo"],
      ["warning", "shallow"],
    ]);
  });
});
