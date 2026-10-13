import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince } from "../support/k8s.js";
import { deployedEngine } from "../support/engine.js";
import {
  applyEventTrigger,
  deleteEventFixtures,
  invokeEvent,
  runSuffix,
  waitForInvocation,
  waitForReady,
  waitForTriggersLoaded,
  webhookEnvelope,
} from "../support/events.js";
import { fakeSinkRequests, replyPath, replyUrl, resetFakeSink } from "../support/fake-sink.js";

requireMinikubeContext();

/**
 * The programmatic entry point with an event: `POST /invoke {event}` straight
 * at agent-orchestrator (docs/event-triggers.md §4-5), no gateway in between.
 *
 *   no trigger matched          200 {"status":"ignored"} -- no turn, no RAG fallback
 *   matched, params error       422 {"status":"failed","error"}
 *   matched                     202 {id, status:"pending", trigger:{name, sessionId, reply}}
 *
 * Matching lives in the orchestrator in BOTH engine modes (the Temporal engine
 * is handed the resolved turn, never the envelope), so this file is engine
 * agnostic by contract and runs unchanged against either.
 *
 * It is also where the shipped EXAMPLE triggers' rendering is pinned without a
 * GitHub/Slack round trip: `trigger.sessionId` and the rendered
 * `trigger.reply` are exactly what the gateway's adapters act on, and the
 * end-to-end specs can only observe their side-effects.
 *
 * Per-test triggers live on the `generic-hmac` source and match only this run's
 * `body.e2eInvoke` id, so they can never catch another spec's events.
 */

const FIXTURE = "invoke";
const ID = runSuffix();

/** Every per-test trigger's match: this run, this case. */
const caseMatch = (c: string) => ({ cel: `has(body.e2eInvoke) && body.e2eInvoke == "${ID}" && body.case == "${c}"` });
const caseEnvelope = (c: string, extra: Record<string, unknown> = {}) =>
  webhookEnvelope("generic-hmac", { e2eInvoke: ID, case: c, ...extra });
/** A turn that costs one short planner call and touches nothing. */
const CHEAP_TARGET = { orchestrator: {}, promptTemplate: "Reply with the single word OK." };

describe(`POST /invoke with an event envelope (engine: ${deployedEngine()})`, () => {
  let startedAt: Date;

  beforeAll(async () => {
    startedAt = new Date();
    await resetFakeSink();

    // ── per-test triggers ──
    await applyEventTrigger(`e2e-inv-params-${ID}`, {
      sourceRef: "generic-hmac",
      match: caseMatch("params"),
      // Compiles; fails to EVALUATE on this body (no such key) -> §3: a params
      // error after a match fails the event, never an empty value.
      params: { missing: "body.notThere.deeper" },
      target: CHEAP_TARGET,
    }, FIXTURE);
    await applyEventTrigger(`e2e-inv-ok-${ID}`, {
      sourceRef: "generic-hmac",
      match: caseMatch("ok"),
      params: { n: "body.n" },
      sessionKey: "e2e-invoke:{{n}}",
      target: CHEAP_TARGET,
      reply: { http: { url: replyUrl(`e2e-inv-ok-${ID}`) } },
    }, FIXTURE);
    await applyEventTrigger(`e2e-inv-nokey-${ID}`, {
      sourceRef: "generic-hmac",
      match: caseMatch("nokey"),
      target: CHEAP_TARGET,
    }, FIXTURE);

    // ── priority: higher priority beats a smaller name ──
    await applyEventTrigger(`e2e-prio-zz-${ID}`, { sourceRef: "generic-hmac", priority: 10, match: caseMatch("prio"), target: CHEAP_TARGET }, FIXTURE);
    await applyEventTrigger(`e2e-prio-aa-${ID}`, { sourceRef: "generic-hmac", priority: 0, match: caseMatch("prio"), target: CHEAP_TARGET }, FIXTURE);
    // ── tie: equal priority -> lexicographically smallest name ──
    await applyEventTrigger(`e2e-tie-bb-${ID}`, { sourceRef: "generic-hmac", priority: 5, match: caseMatch("tie"), target: CHEAP_TARGET }, FIXTURE);
    await applyEventTrigger(`e2e-tie-aa-${ID}`, { sourceRef: "generic-hmac", priority: 5, match: caseMatch("tie"), target: CHEAP_TARGET }, FIXTURE);

    for (const n of ["params", "ok", "nokey"]) await waitForReady("eventtrigger", `e2e-inv-${n}-${ID}`, "True", "Resolved");
    for (const n of ["prio-zz", "prio-aa", "tie-bb", "tie-aa"]) await waitForReady("eventtrigger", `e2e-${n}-${ID}`, "True", "Resolved");
    // All of the above are in the orchestrator's registry before any case runs:
    // a priority test that raced the informer would "win" with whichever
    // trigger happened to be loaded.
    await waitForTriggersLoaded(FIXTURE);
  });

  afterAll(async () => {
    await deleteEventFixtures(FIXTURE);
    await cleanupAgentRunsSince(startedAt);
  });

  describe("outcomes", () => {
    it("200 ignored when nothing matches -- including an unknown source", async () => {
      for (const env of [
        caseEnvelope("no-such-case"),
        webhookEnvelope("e2e-no-such-source", { e2eInvoke: ID, case: "ok", n: 1 }),
      ]) {
        const r = await invokeEvent(env);
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ status: "ignored" });
      }
    });

    it("422 failed when the winner's params cannot be evaluated", async () => {
      const r = await invokeEvent(caseEnvelope("params"));
      expect(r.status).toBe(422);
      expect(r.body.status).toBe("failed");
      expect(typeof r.body.error).toBe("string");
      expect(r.body.id, "a failed match must not create an invocation").toBeUndefined();
    });

    it("202 with the trigger, its rendered sessionKey, and its rendered reply; the turn is real", async () => {
      const r = await invokeEvent(caseEnvelope("ok", { n: 42 }));
      expect(r.status).toBe(202);
      expect(r.body.status).toBe("pending");
      expect(r.body.trigger?.name).toBe(`e2e-inv-ok-${ID}`);
      // {{n}} with an int param renders in decimal (§4).
      expect(r.body.trigger?.sessionId).toBe("e2e-invoke:42");
      expect(r.body.trigger?.reply).toMatchObject({ http: { url: replyUrl(`e2e-inv-ok-${ID}`) } });

      const settled = await waitForInvocation(r.body.id as string);
      expect(settled.status).toBe("succeeded");
      // Reply adapters belong to integration-gateway; a direct /invoke caller
      // gets the rendered reply back and is on its own. Red if the
      // orchestrator started POSTing replies itself.
      expect((await fakeSinkRequests()).filter((q) => q.path === replyPath(`e2e-inv-ok-${ID}`))).toEqual([]);
    });

    it("session id: the caller's session_id when the trigger has no sessionKey, else event:<source>:<id>", async () => {
      const callerSession = `e2e-caller-${ID}`;
      const withCaller = await invokeEvent(caseEnvelope("nokey"), { sessionId: callerSession });
      expect(withCaller.status).toBe(202);
      expect(withCaller.body.trigger?.sessionId).toBe(callerSession);
      expect(withCaller.body.trigger?.reply).toBeNull();

      const env = caseEnvelope("nokey");
      const bare = await invokeEvent(env);
      expect(bare.status).toBe(202);
      expect(bare.body.trigger?.sessionId).toBe(`event:generic-hmac:${env.id}`);
    });
  });

  describe("winner selection (§4.2)", () => {
    it("higher priority wins over a lexicographically smaller name", async () => {
      const r = await invokeEvent(caseEnvelope("prio"));
      expect(r.status).toBe(202);
      expect(r.body.trigger?.name).toBe(`e2e-prio-zz-${ID}`);
    });

    it("equal priority: the lexicographically smallest name wins", async () => {
      const r = await invokeEvent(caseEnvelope("tie"));
      expect(r.status).toBe(202);
      // bb was applied FIRST, so an insertion-order winner would pick it.
      expect(r.body.trigger?.name).toBe(`e2e-tie-aa-${ID}`);
    });
  });

  describe("the shipped example triggers, rendered", () => {
    it("github-issue-triage: sessionKey github:<repo>#<n> and a rendered reply.github", async () => {
      const issue = 90_000 + (Date.now() % 9_000);
      const r = await invokeEvent(
        webhookEnvelope(
          "github",
          {
            action: "labeled",
            label: { name: "ai-triage" },
            issue: { number: issue, title: "rendered?", body: "body" },
            repository: { full_name: "e2e-org/e2e-repo" },
            sender: { login: "e2e-user", type: "User" },
          },
          { headers: { "x-github-event": "issues" }, repository: "e2e-org/e2e-repo" },
        ),
      );
      expect(r.status).toBe(202);
      expect(r.body.trigger?.name).toBe("github-issue-triage");
      expect(r.body.trigger?.sessionId).toBe(`github:e2e-org/e2e-repo#${issue}`);
      // issueNumber rendered AND converted to a number (§5); every template rendered.
      expect(r.body.trigger?.reply).toMatchObject({
        github: expect.objectContaining({
          repository: "e2e-org/e2e-repo",
          issueNumber: issue,
          sessionPage: true,
          result: true,
          removeLabel: "ai-triage",
          ack: expect.stringContaining("Starting work on this now."),
        }),
      });
      expect(JSON.stringify(r.body.trigger?.reply)).not.toContain("{{");
    });

    it("slack-mention-chat: one session per Slack thread, no reply", async () => {
      const r = await invokeEvent(
        webhookEnvelope("slack", {
          type: "event_callback",
          event: { type: "app_mention", text: "<@U0E2EBOT> hello", channel: "C0E2EINV", ts: "1700000000.000200", thread_ts: "1700000000.000100" },
        }),
      );
      expect(r.status).toBe(202);
      expect(r.body.trigger?.name).toBe("slack-mention-chat");
      // thread_ts present -> the THREAD, not the message, keys the session.
      expect(r.body.trigger?.sessionId).toBe("slack:C0E2EINV:1700000000.000100");
      expect(r.body.trigger?.reply).toBeNull();
    });
  });
});
