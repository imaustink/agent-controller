import { describe, expect, it } from "vitest";
import type { AgentDownMessage, AgentUpMessage } from "@controller-agent/messaging";
import type { AgentChannel } from "./channel.js";
import { runAgent, type AgentRuntimeConfig } from "./index.js";

const config: AgentRuntimeConfig = {
  natsUrl: "nats://test",
  runId: "run-1",
  subjectPrefix: "agent",
  goal: "do the thing",
};

/** In-memory channel: records up-messages, lets the test push down-messages. */
class FakeChannel implements AgentChannel {
  readonly up: AgentUpMessage[] = [];
  private handler: ((msg: AgentDownMessage) => void) | undefined;
  closed = false;

  publishUp(msg: AgentUpMessage): Promise<void> {
    this.up.push(msg);
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
});
