/**
 * Integration probes for the agent channel: a REAL nats.js client against a
 * real socket, with real timers and a real NATS outage. These exist because
 * the production bug they cover was invisible to unit tests with a faked
 * connection — the defect lived in nats.js's actual subscription and reconnect
 * semantics, not in our control flow.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSubjects } from "@controller-agent/messaging";
import { FakeNatsServer } from "./fake-nats-server.js";
import { AgentTurnTimeoutError, AgentTurnTransportError, NatsAgentChannel } from "./nats-agent-channel.js";

const RUN_ID = "0f97aa3d-dc2c-45eb-a5b4-51c94e1de788";
const UP = agentSubjects(RUN_ID).up;
/** Long enough to exhaust nats.js's default 10 reconnect attempts at 2s apart. */
const OUTAGE_MS = 23_000;

let server: FakeNatsServer;

beforeEach(async () => {
  server = new FakeNatsServer();
  await server.start();
});

afterEach(async () => {
  await server.stop();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("agent channel across a real NATS outage", () => {
  it("FIX: the new code rides out the same outage and still delivers the reply", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const port = server.port;
    const pending = channel.awaitReply(RUN_ID, { idleTimeoutMs: 10 * 60 * 1000 });

    await server.flushed();
    server.publish(UP, { type: "progress", message: "Authenticating…", agent_run_id: RUN_ID, seq: 0, ts: new Date().toISOString() });
    await sleep(300);

    await server.stop();
    await sleep(OUTAGE_MS);

    // NATS comes back; the client must have kept retrying and must resubscribe.
    server = new FakeNatsServer(port);
    await server.start();
    await sleep(6000);
    server.publish(UP, {
      type: "reply",
      message: "Opened a pull request",
      final: true,
      agent_run_id: RUN_ID,
      seq: 1,
      ts: new Date().toISOString(),
    });

    const reply = await pending;
    console.log(`  [fix] survived a ${(OUTAGE_MS / 1000).toFixed(0)}s NATS outage and received: "${reply.message}"`);
    expect(reply).toMatchObject({ message: "Opened a pull request", final: true });
    await channel.close().catch(() => {});
  }, 90_000);

  it("FIX: a genuinely silent agent still trips the idle timeout, on real timers", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const started = Date.now();
    const settled = channel
      .awaitReply(RUN_ID, { idleTimeoutMs: 2000 })
      .then(() => undefined, (e: unknown) => e);

    await server.flushed();
    server.publish(UP, { type: "progress", message: "Running coding agent…", agent_run_id: RUN_ID, seq: 0, ts: new Date().toISOString() });

    const err = await settled;
    const elapsedMs = Date.now() - started;
    console.log(`  [idle timeout] 2000ms window fired after ${elapsedMs}ms: "${(err as Error).message}"`);

    expect(err).toBeInstanceOf(AgentTurnTimeoutError);
    expect(elapsedMs).toBeGreaterThanOrEqual(2000);
    expect(elapsedMs).toBeLessThan(6000);
    await channel.close().catch(() => {});
  }, 30_000);

  it("FIX: narration keeps a long run alive well past the idle window", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const pending = channel.awaitReply(RUN_ID, { idleTimeoutMs: 1500 });
    await server.flushed();

    // 6 seconds of work — 4x the idle window — narrating throughout.
    for (let i = 0; i < 12; i++) {
      server.publish(UP, { type: "progress", message: `step ${i}`, agent_run_id: RUN_ID, seq: i, ts: new Date().toISOString() });
      await sleep(500);
    }
    server.publish(UP, { type: "reply", message: "done", final: true, agent_run_id: RUN_ID, seq: 99, ts: new Date().toISOString() });

    const result = await pending;
    expect(result.message).toBe("done");
    expect(result.narration).toHaveLength(12);
    await channel.close().catch(() => {});
  }, 30_000);

  it("FIX: a lost connection reports a transport error, not a fabricated timeout", async () => {
    const channel = await NatsAgentChannel.connect(server.url, "agent");
    // Idle window far longer than the test, so a timeout cannot be the cause.
    const settled = channel
      .awaitReply(RUN_ID, { idleTimeoutMs: 60 * 60 * 1000 })
      .then(() => undefined, (e: unknown) => e);
    await server.flushed();

    await channel.close();

    const err = await settled;
    console.log(`  [transport] ${(err as Error).constructor.name}: "${(err as Error).message}"`);
    expect(err).toBeInstanceOf(AgentTurnTransportError);
    expect(err).not.toBeInstanceOf(AgentTurnTimeoutError);
    expect((err as Error).message).toMatch(/may still be in progress/);
  }, 30_000);
});

/**
 * The mechanism behind the production incident on AgentRun
 * 0f97aa3d-dc2c-45eb-a5b4-51c94e1de788: the run began at 20:15:36Z, an
 * orchestrator rollout replaced the waiting pod 53s later at 20:16:29Z, and
 * the run itself went on to succeed at 20:19:30Z. `shutdown()` in index.ts
 * drains the NATS connection (`agentChannel.close()`) in the same
 * `Promise.all` as `invokeServer.close()`, so the drain lands while the
 * in-flight chat request is still waiting on `awaitReply`.
 */
describe("orchestrator shutdown during an in-flight agent turn", () => {
  it("FIX: the same drain now reports a transport error that admits the run may be alive", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const settled = channel
      .awaitReply(RUN_ID, { idleTimeoutMs: 30 * 60 * 1000 })
      .then(() => undefined, (e: unknown) => e);

    await server.flushed();
    server.publish(UP, { type: "progress", message: "Running coding agent…", agent_run_id: RUN_ID, seq: 0, ts: new Date().toISOString() });
    await sleep(200);
    await channel.close();

    const err = await settled;
    console.log(`  [SIGTERM fixed] ${(err as Error).constructor.name}: "${(err as Error).message}"`);
    expect(err).toBeInstanceOf(AgentTurnTransportError);
    expect(err).not.toBeInstanceOf(AgentTurnTimeoutError);
  }, 30_000);
});
