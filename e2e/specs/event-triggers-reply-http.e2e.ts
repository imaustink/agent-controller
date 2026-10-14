import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince } from "../support/k8s.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { deployedEngine } from "../support/engine.js";
import {
  EVENT_SECRETS,
  applyEventTrigger,
  applyManifest,
  ciBearerToken,
  cleanupToolRunsSince,
  deleteEventFixtures,
  deleteManifest,
  ensureEventSecrets,
  genericHmacSecret,
  replySigningSecret,
  runSuffix,
  slackSigningSecret,
  toolRunDetailsSince,
  waitForReady,
  waitForTriggersLoaded,
  withGateway,
} from "../support/events.js";
import {
  FAKE_SINK_PAGE_MARKER,
  fakeSinkRequests,
  hasValidEventSignature,
  replyPath,
  replyUrl,
  resetFakeSink,
  waitForSinkPost,
} from "../support/fake-sink.js";
import {
  ciFailurePayload,
  genericUrlPayload,
  postBearerWebhook,
  postHmacWebhook,
  postSlackEvent,
  slackAppMentionPayload,
} from "../support/webhook.js";

requireMinikubeContext();

/**
 * The three non-GitHub example sources, each through its own verification
 * scheme to its own target kind, each answering through `reply.http`
 * (docs/event-triggers.md §1, §7):
 *
 *   slack        slackV0  -> target.orchestrator (an ordinary RAG turn)
 *   ci           bearer   -> target.skillRef     (a FORCED skill, no retrieval)
 *   generic-hmac hmac     -> target.toolRef      (one tool run, params.input = the URL)
 *
 * `reply.http` is asserted as a contract, at an in-cluster recorder
 * (manifests/fake-sink.yaml): the documented body {trigger, sessionId, status,
 * result|error}, and `x-event-signature: sha256=<hmac>` recomputed over the
 * RECORDED raw bytes with the Secret the e2e overlay points `reply.http.secretRef`
 * at -- and, as the control that proves that check can fail, rejected under a
 * different secret.
 *
 * Model nondeterminism: the slack turn is a real planner turn, so only its
 * status/shape are asserted, never its prose. The ci skill's markdown dictates a
 * fixed receipt line (manifests/event-trigger-skill.yaml) -- the caller-tools
 * spec's technique for making a forced-skill turn observable.
 */

const FIXTURE = "reply-http";
/** The identity a sender-less source (slack, ci, generic-hmac, cron) runs as. */
const SHARED_SUBJECT = "client-integration-gateway";

describe(`reply.http from slack / ci / generic-hmac (engine: ${deployedEngine()})`, () => {
  let startedAt: Date;
  let replySecret: string;

  beforeAll(async () => {
    startedAt = new Date();
    await ensureEventSecrets();
    await resetFakeSink();
    replySecret = await replySigningSecret();
    await seedAllClaudeCredentials(SHARED_SUBJECT);
  });

  afterAll(async () => {
    await deleteEventFixtures(FIXTURE);
    await deleteManifest("event-trigger-skill.yaml");
    await cleanupAgentRunsSince(startedAt);
    await cleanupToolRunsSince(startedAt);
  });

  function expectSigned(request: Parameters<typeof hasValidEventSignature>[0]): void {
    expect(hasValidEventSignature(request, replySecret), "x-event-signature must verify with reply.http.secretRef").toBe(true);
    // The control: the same check fails under another secret.
    expect(hasValidEventSignature(request, `${replySecret}-not`)).toBe(false);
  }

  it("slack app_mention -> orchestrator turn -> signed reply.http with the thread's session id", async () => {
    // The shipped slack-mention-chat example has no `reply` (there is no Slack
    // reply adapter yet), so its outcome is not observable from outside. This
    // per-test trigger mirrors it -- same match/params/sessionKey -- adds
    // reply.http, and outranks it with `priority`. The example's own selection
    // and session id are asserted through /invoke in event-triggers-invoke.e2e.ts.
    const sfx = runSuffix();
    const name = `e2e-slack-reply-${sfx}`;
    const marker = `e2e-slack-${sfx}`;
    await applyEventTrigger(
      name,
      {
        sourceRef: "slack",
        priority: 100,
        match: { cel: `body.type == "event_callback" && body.event.type == "app_mention" && body.event.text.contains("${marker}")` },
        params: {
          text: "body.event.text",
          channel: "body.event.channel",
          thread: 'has(body.event.thread_ts) ? body.event.thread_ts : body.event.ts',
        },
        sessionKey: "slack:{{channel}}:{{thread}}",
        target: { orchestrator: {}, promptTemplate: "{{text}}" },
        reply: { http: { url: replyUrl(name), secretRef: { name: EVENT_SECRETS.reply.name, key: EVENT_SECRETS.reply.key } } },
      },
      FIXTURE,
    );
    await waitForReady("eventtrigger", name, "True", "Resolved");
    await waitForTriggersLoaded(FIXTURE);

    const ts = `${Math.floor(Date.now() / 1000)}.000100`;
    const { status } = await withGateway(async (f) =>
      postSlackEvent(
        f,
        slackAppMentionPayload({ text: `<@U0E2EBOT> ${marker}: reply with the single word PONG.`, channel: "C0E2E", ts }),
        await slackSigningSecret(),
      ),
    );
    expect(status).toBe(202);

    const { request, body } = await waitForSinkPost(replyPath(name), () => true, 300_000);
    expect(request.headers["content-type"] ?? "").toContain("application/json");
    expectSigned(request);
    expect(body.trigger).toBe(name);
    // sessionKey rendered from params; no thread_ts -> thread = ts.
    expect(body.sessionId).toBe(`slack:C0E2E:${ts}`);
    expect(body.status).toBe("succeeded");
    expect(typeof body.result === "string" && body.result.length > 0, "a succeeded reply carries a result").toBe(true);
  });

  it("ci failure (bearer) -> forced skill -> signed reply.http; a ci success sends nothing", async () => {
    await applyManifest("event-trigger-skill.yaml");
    // The trigger re-resolves when its Skill appears (the controller watches Skills).
    await waitForReady("eventtrigger", "ci-failure-skill", "True", "Resolved");
    await waitForTriggersLoaded(FIXTURE);

    const job = `e2e-ci-${runSuffix()}`;
    const token = await ciBearerToken();
    await withGateway(async (f) => {
      // First a success: matches nothing, so it must produce NO reply.
      expect((await postBearerWebhook(f, "ci", ciFailurePayload({ repository: "e2e-org/e2e-repo", job, status: "success" }), token)).status).toBe(202);
      expect((await postBearerWebhook(f, "ci", ciFailurePayload({ repository: "e2e-org/e2e-repo", job }), token)).status).toBe(202);
    });

    const { request, body } = await waitForSinkPost(replyPath("ci-failure-skill"), () => true, 300_000);
    expectSigned(request);
    expect(body.trigger).toBe("ci-failure-skill");
    // No sessionKey on the example and no deliveryIdHeader on the ci source ->
    // event:<source>:<uuid> (§4.5).
    expect(body.sessionId).toMatch(/^event:ci:[0-9a-f-]{36}$/);
    expect(body.status).toBe("succeeded");
    // Only the forced skill's markdown says this; retrieval picking any other
    // skill (or none) cannot produce it. Red if skillRef stopped forcing.
    expect(String(body.result)).toContain("E2E-CI-SKILL-RECEIPT");
    expect(String(body.result)).toContain(job);

    // Give a wrongly-matched success time to land, then count.
    await new Promise((r) => setTimeout(r, 20_000));
    const posts = (await fakeSinkRequests()).filter((r) => r.method === "POST" && r.path === replyPath("ci-failure-skill"));
    expect(posts, "the ci SUCCESS event must not have produced a reply").toHaveLength(1);
  });

  it("generic-hmac -> web-fetch tool with the URL as its input; the SSRF guard still holds for event-driven runs", async () => {
    // The example only matches https URLs. A cluster-internal one: web-fetch's
    // SSRF guard refuses every RFC1918 address, so this run must FAIL with the
    // guard's error and fake-sink must never see the GET. That pins three
    // things at once: the tool really ran (the error is web-fetch's own), its
    // input was the URL (the guard named the host), and an event body cannot
    // steer a tool at the cluster's insides.
    // Both generic-hmac tests reply on the same path; start from an empty
    // recording so neither can read the other's (or a retry's) reply.
    await resetFakeSink();
    const sfx = runSuffix();
    const internalUrl = `https://fake-sink.controller-agent.svc.cluster.local/page.html?e2e=${sfx}`;
    const toolStartedAt = new Date();
    const { status } = await withGateway(async (f) =>
      postHmacWebhook(f, "generic-hmac", genericUrlPayload(internalUrl), await genericHmacSecret()),
    );
    expect(status).toBe(202);

    const { request, body } = await waitForSinkPost(replyPath("generic-hmac-tool"), () => true, 300_000);
    expectSigned(request);
    expect(body.trigger).toBe("generic-hmac-tool");
    expect(body.status).toBe("failed");
    expect(JSON.stringify(body)).toMatch(/non-public address|blocked/i);
    expect(
      (await fakeSinkRequests()).filter((r) => r.path === "/page.html"),
      "web-fetch reached a cluster-internal page: the SSRF guard did not hold",
    ).toEqual([]);

    // A ToolRun, read-only (the trigger sets readOnly; §1 says every ToolRun a
    // read-only turn launches carries it), for web-fetch, given the URL.
    const runs = (await toolRunDetailsSince(toolStartedAt)).filter((r) => r.toolRef === "web-fetch");
    expect(runs.length, "no web-fetch ToolRun was launched").toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.readOnly, `ToolRun ${run.name} spec.readOnly`).toBe(true);
      expect(run.args.join(" ")).toContain(internalUrl);
    }
  });

  // Needs egress from minikube to the public internet: web-fetch only reads
  // public hosts, so "the result contains the page" has no hermetic version.
  // Set E2E_NO_EGRESS=1 on an offline machine; the guard test above still runs.
  it.skipIf(process.env.E2E_NO_EGRESS === "1")(
    "generic-hmac -> web-fetch on a public https page -> reply.http result carries the page's content",
    async () => {
      const url = "https://example.com/";
      await resetFakeSink();
      const { status } = await withGateway(async (f) =>
        postHmacWebhook(f, "generic-hmac", genericUrlPayload(url, { e2e: runSuffix() }), await genericHmacSecret()),
      );
      expect(status).toBe(202);
      const { request, body } = await waitForSinkPost(
        replyPath("generic-hmac-tool"),
        (b) => b.status === "succeeded",
        300_000,
      );
      expectSigned(request);
      expect(body.trigger).toBe("generic-hmac-tool");
      // example.com's page title -- web-fetch's Markdown carries it verbatim.
      expect(String(body.result)).toContain("Example Domain");
      // The page we serve in-cluster is a different page entirely.
      expect(String(body.result)).not.toContain(FAKE_SINK_PAGE_MARKER);
    },
  );
});
