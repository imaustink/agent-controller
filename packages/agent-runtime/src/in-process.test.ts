import { describe, expect, it } from "vitest";
import { AgentFailure, ToolCallError, createInProcessChannel, runAgent, startLocalAgent } from "./index.js";

describe("startLocalAgent", () => {
  it("runs a whole agent turn in-process: progress, a question, a tool call, a structured reply", async () => {
    const asked: string[] = [];
    const { peer, outcome } = startLocalAgent(
      async (session) => {
        await session.progress("cloning", { stage: "setup", pct: 12.5 });
        const branch = await session.ask("Which branch?");
        const hits = await session.callTool("web-search", JSON.stringify({ q: branch }));
        return { message: `searched ${branch}`, result: { hits } };
      },
      {
        goal: "fix the flaky test",
        onAsk: (question) => {
          asked.push(question);
          return "main";
        },
        tools: { "web-search": (input) => ({ echoed: JSON.parse(input).q, n: 3 }) },
      },
    );

    await expect(outcome).resolves.toEqual({
      status: "replied",
      message: "searched main",
      result: { hits: { echoed: "main", n: 3 } },
    });
    expect(asked).toEqual(["Which branch?"]);
    expect(peer.up.map((m) => m.type)).toEqual(["ready", "progress", "reply", "tool_call", "reply"]);
    expect(peer.up[1]).toMatchObject({ type: "progress", stage: "setup", pct: 12.5 });
    await peer.closed;
  });

  it("hands the goal to the handler", async () => {
    const { outcome } = startLocalAgent(async (session) => `goal was: ${session.goal}`, { goal: "count to 3" });
    await expect(outcome).resolves.toMatchObject({ message: "goal was: count to 3" });
  });

  it("cancels, rather than hanging, when the agent asks a question nobody can answer", async () => {
    const { outcome } = startLocalAgent(async (session) => session.ask("Anyone there?"), { goal: "g" });
    await expect(outcome).resolves.toEqual({ status: "cancelled" });
  });

  it("reports a declared failure with its code", async () => {
    const { outcome } = startLocalAgent(
      async () => {
        throw new AgentFailure("AUTH", "no token");
      },
      { goal: "g" },
    );
    await expect(outcome).resolves.toEqual({ status: "failed", code: "AUTH", message: "no token" });
  });

  it("turns an unknown or failing tool into a ToolCallError inside the handler", async () => {
    const seen: string[] = [];
    const { outcome } = startLocalAgent(
      async (session) => {
        for (const tool of ["missing", "broken"]) {
          try {
            await session.callTool(tool, "{}");
          } catch (err) {
            expect(err).toBeInstanceOf(ToolCallError);
            seen.push((err as Error).message);
          }
        }
        return "ok";
      },
      {
        goal: "g",
        tools: {
          broken: () => {
            throw new Error("upstream down");
          },
        },
      },
    );
    await expect(outcome).resolves.toMatchObject({ status: "replied" });
    expect(seen).toEqual(['no local tool named "missing"', "upstream down"]);
  });
});

describe("createInProcessChannel", () => {
  it("acknowledges concluding messages so the agent stops holding them", async () => {
    const { channel, peer } = createInProcessChannel({ runId: "r1" });
    const acks: number[] = [];
    channel.onDown((msg) => {
      if (msg.type === "reply_ack") acks.push(msg.ackSeq);
    });
    await channel.publishUp({ agent_run_id: "r1", seq: 4, ts: "t", type: "reply", message: "done", final: true });
    await Promise.resolve();
    expect(acks).toEqual([4]);
    expect(peer.up).toHaveLength(1);
  });

  it("does not ack when autoAck is off, so a test can play an orchestrator that never answers", async () => {
    const { channel } = createInProcessChannel({ autoAck: false });
    const received: string[] = [];
    channel.onDown((msg) => received.push(msg.type));
    await channel.publishUp({ agent_run_id: "local", seq: 0, ts: "t", type: "failed", code: "C", message: "m" });
    await Promise.resolve();
    expect(received).toEqual([]);
  });

  it("rejects messages that would be rejected on the wire, in both directions", async () => {
    const { channel, peer } = createInProcessChannel();
    await expect(
      // A reply without `final` is exactly what an omitempty encoder used to produce.
      channel.publishUp({ agent_run_id: "local", seq: 0, ts: "t", type: "reply", message: "m" } as never),
    ).rejects.toThrow(/violates the agent protocol/);
    expect(() => peer.send({ type: "tool_result", callId: "c" } as never)).toThrow(/violates the agent protocol/);
    expect(peer.up).toHaveLength(0);
  });

  it("delivers down-messages asynchronously, never re-entrantly", () => {
    const { channel, peer } = createInProcessChannel();
    const received: string[] = [];
    channel.onDown((msg) => received.push(msg.type));
    peer.send({ type: "prompt", message: "hi" });
    expect(received).toEqual([]);
  });

  it("lets a test drive runAgent directly and await specific messages", async () => {
    const { channel, peer } = createInProcessChannel();
    const done = runAgent(async (session) => session.ask("Proceed?"), {
      channel,
      config: { runId: "local", goal: "g", subjectPrefix: "agent" },
    });
    const question = await peer.next((m) => m.type === "reply" && !m.final);
    expect(question).toMatchObject({ message: "Proceed?" });
    peer.send({ type: "prompt", message: "yes" });
    await done;
    expect(peer.up.at(-1)).toMatchObject({ type: "reply", final: true, message: "yes" });
  });
});
