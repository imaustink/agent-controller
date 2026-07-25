/**
 * Validates the shutdown ORDERING fixed in index.ts, which is what actually
 * broke AgentRun 0f97aa3d: the old `shutdown()` put `invokeServer.close()` and
 * `agentChannel.close()` in one `Promise.all`, so NATS was drained while a
 * chat request was still parked on `awaitReply`.
 *
 * Modelled directly on index.ts's two phases rather than importing it (main()
 * builds the whole world: Qdrant, k8s watches, Redis). The ordering is the
 * thing under test, so the test states both orderings explicitly and shows the
 * difference in outcome for an in-flight turn.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSubjects } from "@controller-agent/messaging";
import { FakeNatsServer } from "./agents/fake-nats-server.js";
import { AgentTurnTransportError, NatsAgentChannel } from "./agents/nats-agent-channel.js";

const RUN_ID = "0f97aa3d-dc2c-45eb-a5b4-51c94e1de788";
const UP = agentSubjects(RUN_ID).up;
const DRAIN_MS = 5000;

let server: FakeNatsServer;

beforeEach(async () => {
  server = new FakeNatsServer();
  await server.start();
});
afterEach(async () => {
  await server.stop();
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Stands in for the in-flight `POST /invoke` that is awaiting an agent turn. */
function inFlightTurn(channel: NatsAgentChannel) {
  let settled = false;
  const promise = channel
    .awaitReply(RUN_ID, { idleTimeoutMs: 30 * 60 * 1000 })
    .then(
      (r) => {
        settled = true;
        return { ok: true as const, value: r };
      },
      (e: unknown) => {
        settled = true;
        return { ok: false as const, error: e };
      },
    );
  return { promise, isSettled: () => settled };
}

describe("shutdown ordering vs. an in-flight agent turn", () => {
  it("OLD ORDERING: draining NATS alongside the HTTP close kills the healthy turn", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const turn = inFlightTurn(channel);
    await server.flushed();
    server.publish(UP, { type: "progress", message: "Running coding agent…", agent_run_id: RUN_ID, seq: 0, ts: new Date().toISOString() });
    await sleep(150);

    // The old shutdown(): HTTP drain and NATS drain in ONE Promise.all. The
    // HTTP server would wait for this very request, but the NATS drain does
    // not wait for anything.
    const httpClose = (async () => {
      await turn.promise; // what server.close() is really waiting on
    })();
    await Promise.all([httpClose, channel.close()]);

    const outcome = await turn.promise;
    console.log(`  [old ordering] turn outcome: ${outcome.ok ? "reply" : (outcome.error as Error).constructor.name}`);
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AgentTurnTransportError);
  }, 30_000);

  it("NEW ORDERING: the turn completes first, so the reply is delivered", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const turn = inFlightTurn(channel);
    await server.flushed();
    server.publish(UP, { type: "progress", message: "Running coding agent…", agent_run_id: RUN_ID, seq: 0, ts: new Date().toISOString() });
    await sleep(150);

    // The agent finishes 1s into the shutdown — well inside the drain window.
    setTimeout(() => {
      server.publish(UP, {
        type: "reply",
        message: "Opened a pull request",
        final: true,
        agent_run_id: RUN_ID,
        seq: 1,
        ts: new Date().toISOString(),
      });
    }, 1000);

    // index.ts phase 1: bounded wait for in-flight requests.
    const drained = turn.promise.then(() => "drained" as const);
    const outcomeOfRace = await Promise.race([
      drained,
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), DRAIN_MS)),
    ]);
    expect(outcomeOfRace).toBe("drained");
    expect(turn.isSettled()).toBe(true);

    // index.ts phase 2: only now tear down the transport.
    await channel.close();

    const outcome = await turn.promise;
    console.log(`  [new ordering] turn outcome: ${outcome.ok ? `reply "${outcome.value.message}"` : (outcome.error as Error).constructor.name}`);
    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.value.message).toBe("Opened a pull request");
  }, 30_000);

  it("NEW ORDERING: a turn outlasting the drain deadline still lets shutdown proceed", async () => {
    const channel = await NatsAgentChannel.connect(server.url);
    const turn = inFlightTurn(channel);
    await server.flushed();
    server.publish(UP, { type: "progress", message: "long build…", agent_run_id: RUN_ID, seq: 0, ts: new Date().toISOString() });
    await sleep(150);

    // No reply ever comes — the agent is still working past the grace period.
    const started = Date.now();
    const outcomeOfRace = await Promise.race([
      turn.promise.then(() => "drained" as const),
      new Promise<"deadline">((resolve) => setTimeout(() => resolve("deadline"), 1500)),
    ]);
    expect(outcomeOfRace).toBe("deadline");
    expect(turn.isSettled()).toBe(false);

    await channel.close();
    const outcome = await turn.promise;
    console.log(
      `  [new ordering, over deadline] gave up after ${Date.now() - started}ms: ${(outcome as { error: Error }).error.constructor.name}`,
    );
    // Bounded: shutdown is not blocked forever by a long-running turn, and the
    // error it reports is honest about the run possibly still being alive.
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBeInstanceOf(AgentTurnTransportError);
  }, 30_000);
});
