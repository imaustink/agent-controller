import { describe, expect, it } from "vitest";
import type { AgentDownMessage, AgentUpMessage } from "@controller-agent/messaging";
import type { AgentChannel } from "./channel.js";
import { AgentFailure, runAgent, ToolCallError, type AgentRuntimeConfig } from "./index.js";

const config: AgentRuntimeConfig = {
  natsUrl: "nats://test",
  runId: "run-1",
  subjectPrefix: "agent",
  goal: "do the thing",
};

/**
 * In-memory channel: records up-messages, lets the test push down-messages.
 *
 * Acks `reply`/`failed` by default, because a live orchestrator does (see the
 * protocol's `reply_ack`) and the runtime holds those messages until it hears
 * one. Tests that exercise the holding itself construct this with
 * `{ autoAck: false }` to stand in for an orchestrator that has gone away.
 */
class FakeChannel implements AgentChannel {
  readonly up: AgentUpMessage[] = [];
  private handler: ((msg: AgentDownMessage) => void) | undefined;
  closed = false;

  constructor(private readonly opts: { autoAck?: boolean } = {}) {}

  publishUp(msg: AgentUpMessage): Promise<void> {
    this.up.push(msg);
    if ((this.opts.autoAck ?? true) && (msg.type === "reply" || msg.type === "failed")) {
      // Asynchronously, like a real round trip -- an ack delivered
      // synchronously inside publishUp would hide ordering bugs.
      queueMicrotask(() => this.send({ type: "reply_ack", ackSeq: msg.seq }));
    }
    return Promise.resolve();
  }
  onDown(handler: (msg: AgentDownMessage) => void): void {
    this.handler = handler;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  /** Deliver a down-message as if it arrived from the orchestrator. */
  send(msg: Omit<AgentDownMessage, "agent_run_id" | "seq" | "ts">): void {
    this.handler?.({ ...msg, agent_run_id: "run-1", seq: 0, ts: "t" } as AgentDownMessage);
  }
  types(): string[] {
    return this.up.map((m) => m.type);
  }
}

describe("runAgent", () => {
  it("announces ready then publishes a final reply from a string return", async () => {
    const ch = new FakeChannel();
    await runAgent(async (s) => `done: ${s.goal}`, { channel: ch, config });

    expect(ch.types()).toEqual(["ready", "reply"]);
    const reply = ch.up[1] as Extract<AgentUpMessage, { type: "reply" }>;
    expect(reply).toMatchObject({ message: "done: do the thing", final: true });
    expect(ch.closed).toBe(true);
  });

  it("emits progress and warning up-messages", async () => {
    const ch = new FakeChannel();
    await runAgent(
      async (s) => {
        await s.progress("cloning", { stage: "setup", pct: 10 });
        await s.warn("slow network");
        return { message: "ok", result: { n: 1 } };
      },
      { channel: ch, config },
    );

    expect(ch.types()).toEqual(["ready", "progress", "warning", "reply"]);
    expect(ch.up[1]).toMatchObject({ type: "progress", message: "cloning", stage: "setup", pct: 10 });
    expect(ch.up[3]).toMatchObject({ type: "reply", final: true, result: { n: 1 } });
  });

  it("ask() emits a non-final reply and resolves with the next prompt", async () => {
    const ch = new FakeChannel();
    const done = runAgent(
      async (s) => {
        const answer = await s.ask("Which branch?");
        return `using ${answer}`;
      },
      { channel: ch, config },
    );

    // Let the handler reach ask() and publish the question.
    await new Promise((r) => setTimeout(r, 0));
    const question = ch.up.find((m) => m.type === "reply") as Extract<AgentUpMessage, { type: "reply" }>;
    expect(question).toMatchObject({ message: "Which branch?", final: false });

    ch.send({ type: "prompt", message: "main" });
    await done;

    const final = ch.up.filter((m) => m.type === "reply").at(-1) as Extract<AgentUpMessage, { type: "reply" }>;
    expect(final).toMatchObject({ message: "using main", final: true });
  });

  it("publishes a failed up-message when the handler throws", async () => {
    const ch = new FakeChannel();
    await runAgent(
      async () => {
        throw new Error("boom");
      },
      { channel: ch, config },
    );

    expect(ch.types()).toEqual(["ready", "failed"]);
    expect(ch.up[1]).toMatchObject({ type: "failed", code: "agent_error", message: "boom" });
  });

  it("forwards an AgentFailure's own code, so the orchestrator can act on a recoverable failure", async () => {
    const ch = new FakeChannel();
    await runAgent(
      async () => {
        throw new AgentFailure("claude_remote_auth_expired", "credentials look expired");
      },
      { channel: ch, config },
    );

    expect(ch.up[1]).toMatchObject({
      type: "failed",
      code: "claude_remote_auth_expired",
      message: "credentials look expired",
    });
  });

  it("does not let an ordinary Node error's `code` become the wire failure code", async () => {
    const ch = new FakeChannel();
    await runAgent(
      async () => {
        throw Object.assign(new Error("open /nope failed"), { code: "ENOENT" });
      },
      { channel: ch, config },
    );

    expect(ch.up[1]).toMatchObject({ type: "failed", code: "agent_error" });
  });

  it("callTool() publishes a tool_call and resolves from the correlated tool_result", async () => {
    const ch = new FakeChannel();
    const done = runAgent(
      async (s) => {
        const result = await s.callTool("kubectl-readonly", "get pods -n default");
        return { message: "ok", result };
      },
      { channel: ch, config },
    );

    await new Promise((r) => setTimeout(r, 0));
    const call = ch.up.find((m) => m.type === "tool_call") as Extract<AgentUpMessage, { type: "tool_call" }>;
    expect(call).toMatchObject({ tool: "kubectl-readonly", input: "get pods -n default" });

    ch.send({ type: "tool_result", callId: call.callId, ok: true, result: { pods: [] } });
    await done;

    const reply = ch.up.filter((m) => m.type === "reply").at(-1) as Extract<AgentUpMessage, { type: "reply" }>;
    expect(reply).toMatchObject({ message: "ok", final: true, result: { pods: [] } });
  });

  it("callTool() throws ToolCallError when the tool_result reports ok: false", async () => {
    const ch = new FakeChannel();
    const done = runAgent(
      async (s) => {
        await s.callTool("kubectl-readonly", "get pods -n default");
        return "unreachable";
      },
      { channel: ch, config },
    );

    await new Promise((r) => setTimeout(r, 0));
    const call = ch.up.find((m) => m.type === "tool_call") as Extract<AgentUpMessage, { type: "tool_call" }>;
    ch.send({ type: "tool_result", callId: call.callId, ok: false, error: "tool not declared in toolRefs" });
    await done;

    expect(ch.types()).toEqual(["ready", "tool_call", "failed"]);
    expect(ch.up[2]).toMatchObject({ type: "failed", message: "tool not declared in toolRefs" });
  });

  it("callTool() correlates multiple concurrent calls by callId", async () => {
    const ch = new FakeChannel();
    const done = runAgent(
      async (s) => {
        const [a, b] = await Promise.all([s.callTool("tool-a", "x"), s.callTool("tool-b", "y")]);
        return { message: "ok", result: { a, b } };
      },
      { channel: ch, config },
    );

    await new Promise((r) => setTimeout(r, 0));
    const calls = ch.up.filter((m) => m.type === "tool_call") as Extract<AgentUpMessage, { type: "tool_call" }>[];
    expect(calls).toHaveLength(2);
    const callA = calls.find((c) => c.tool === "tool-a")!;
    const callB = calls.find((c) => c.tool === "tool-b")!;

    // Resolve out of order to prove correlation isn't positional.
    ch.send({ type: "tool_result", callId: callB.callId, ok: true, result: "B" });
    ch.send({ type: "tool_result", callId: callA.callId, ok: true, result: "A" });
    await done;

    const reply = ch.up.filter((m) => m.type === "reply").at(-1) as Extract<AgentUpMessage, { type: "reply" }>;
    expect(reply.result).toEqual({ a: "A", b: "B" });
  });

  it("cancel rejects a pending tool call and fires the abort signal without a failed reply", async () => {
    const ch = new FakeChannel();
    let aborted = false;
    const done = runAgent(
      async (s) => {
        s.signal.addEventListener("abort", () => {
          aborted = true;
        });
        try {
          await s.callTool("kubectl-readonly", "get pods");
          return "unreachable";
        } catch (err) {
          expect(err).not.toBeInstanceOf(ToolCallError);
          throw err;
        }
      },
      { channel: ch, config },
    );

    await new Promise((r) => setTimeout(r, 0));
    ch.send({ type: "cancel", reason: "user left" });
    await done;

    expect(aborted).toBe(true);
    expect(ch.types()).toEqual(["ready", "tool_call"]);
    expect(ch.closed).toBe(true);
  });

  it("cancel rejects a pending ask and fires the abort signal without a failed reply", async () => {
    const ch = new FakeChannel();
    let aborted = false;
    const done = runAgent(
      async (s) => {
        s.signal.addEventListener("abort", () => {
          aborted = true;
        });
        await s.ask("Which branch?");
        return "unreachable";
      },
      { channel: ch, config },
    );

    await new Promise((r) => setTimeout(r, 0));
    ch.send({ type: "cancel", reason: "user left" });
    await done;

    expect(aborted).toBe(true);
    // ready + the non-final ask reply only; no final reply, no failed.
    expect(ch.types()).toEqual(["ready", "reply"]);
    expect(ch.closed).toBe(true);
  });

  /**
   * The agent's half of surviving an orchestrator that vanishes mid-turn. Core
   * NATS drops a message published with no live subscriber, so the concluding
   * message is held and re-offered until acked -- that hold is what a
   * replacement orchestrator re-attaches to and collects.
   */
  describe("holding a concluding message until it is acked", () => {
    it("re-offers the same reply, seq unchanged, until an ack arrives", async () => {
      const ch = new FakeChannel({ autoAck: false });
      const done = runAgent(async () => "the answer", {
        channel: ch,
        config,
        replyAckRetryMs: 5,
        replyAckTimeoutMs: 5_000,
      });

      // Enough retry intervals to be sure it is re-offering rather than having
      // published once and moved on.
      await new Promise((r) => setTimeout(r, 40));
      const offers = ch.up.filter((m) => m.type === "reply");
      expect(offers.length).toBeGreaterThan(1);
      // A re-offer must be the SAME message, not a second reply: the seq is how
      // the orchestrator recognizes a duplicate.
      expect(new Set(offers.map((m) => m.seq)).size).toBe(1);
      expect(offers.every((m) => (m as Extract<AgentUpMessage, { type: "reply" }>).message === "the answer")).toBe(true);

      ch.send({ type: "reply_ack", ackSeq: offers[0]!.seq });
      await done;

      const after = ch.up.filter((m) => m.type === "reply").length;
      await new Promise((r) => setTimeout(r, 20));
      // Acked, so it stopped: no further offers after the run resolved.
      expect(ch.up.filter((m) => m.type === "reply").length).toBe(after);
      expect(ch.closed).toBe(true);
    });

    it("gives up after the ack timeout instead of holding the pod open forever", async () => {
      const ch = new FakeChannel({ autoAck: false });
      await runAgent(async () => "the answer", {
        channel: ch,
        config,
        replyAckRetryMs: 5,
        replyAckTimeoutMs: 20,
      });

      // Resolved without an ack -- the whole point is that an uncollected answer
      // costs a logged warning, not a Job that never finishes.
      expect(ch.up.filter((m) => m.type === "reply").length).toBeGreaterThan(0);
      expect(ch.closed).toBe(true);
    });

    it("holds a failed message too", async () => {
      const ch = new FakeChannel({ autoAck: false });
      const done = runAgent(
        async () => {
          throw new AgentFailure("claude_auth_expired", "credential expired");
        },
        { channel: ch, config, replyAckRetryMs: 5, replyAckTimeoutMs: 5_000 },
      );

      await new Promise((r) => setTimeout(r, 30));
      const offers = ch.up.filter((m) => m.type === "failed");
      expect(offers.length).toBeGreaterThan(1);
      expect(new Set(offers.map((m) => m.seq)).size).toBe(1);

      ch.send({ type: "reply_ack", ackSeq: offers[0]!.seq });
      await done;
      expect(ch.closed).toBe(true);
    });

    it("stops holding a question once its answer arrives, even unacked", async () => {
      const ch = new FakeChannel({ autoAck: false });
      const done = runAgent(
        async (s) => {
          const answer = await s.ask("Which branch?");
          return `on ${answer}`;
        },
        { channel: ch, config, replyAckRetryMs: 5, replyAckTimeoutMs: 5_000 },
      );

      await new Promise((r) => setTimeout(r, 20));
      // The answer proves the question landed; re-offering it after that would
      // surface a stale question to the next turn.
      ch.send({ type: "prompt", message: "main" });
      await new Promise((r) => setTimeout(r, 30));
      const questionOffers = ch.up.filter(
        (m) => m.type === "reply" && !(m as Extract<AgentUpMessage, { type: "reply" }>).final,
      ).length;
      await new Promise((r) => setTimeout(r, 20));
      expect(
        ch.up.filter((m) => m.type === "reply" && !(m as Extract<AgentUpMessage, { type: "reply" }>).final).length,
      ).toBe(questionOffers);

      // And the final reply is a separate hold with its own seq.
      const final = ch.up.find((m) => m.type === "reply" && (m as Extract<AgentUpMessage, { type: "reply" }>).final);
      expect(final).toBeDefined();
      ch.send({ type: "reply_ack", ackSeq: final!.seq });
      await done;
    });
  });
});

/**
 * The hold keeps a finished agent's pod alive until its answer is collected,
 * which makes it an operational knob, not just an internal detail: an
 * orchestrator that never acks (an older image deployed against a newer agent)
 * would otherwise keep every Job Running for the full timeout.
 */
describe("reply-ack configuration", () => {
  it("takes the hold window from config when the caller passes none", async () => {
    const ch = new FakeChannel({ autoAck: false });
    await runAgent(async () => "the answer", {
      channel: ch,
      config: { ...config, replyAckRetryMs: 5, replyAckTimeoutMs: 20 },
    });

    expect(ch.up.filter((m) => m.type === "reply").length).toBeGreaterThan(1);
    expect(ch.closed).toBe(true);
  });

  it("publishes once and exits when holding is disabled (timeout 0)", async () => {
    const ch = new FakeChannel({ autoAck: false });
    await runAgent(async () => "the answer", {
      channel: ch,
      config: { ...config, replyAckTimeoutMs: 0 },
    });

    expect(ch.up.filter((m) => m.type === "reply").length).toBe(1);
    expect(ch.closed).toBe(true);
  });
});
