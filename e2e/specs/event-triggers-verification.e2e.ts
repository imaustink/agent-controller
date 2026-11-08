import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince, kubectl } from "../support/k8s.js";
import { deployedEngine } from "../support/engine.js";
import {
  agentRunDetailsSince,
  ciBearerToken,
  ensureEventSecrets,
  genericHmacSecret,
  githubWebhookSecret,
  slackSigningSecret,
  mintServiceAccountToken,
  tickToken,
  withGateway,
} from "../support/events.js";
import {
  hmacSha256Hex,
  postBearerWebhook,
  postGithubDelivery,
  postHmacWebhook,
  postSlackEvent,
  postTick,
  postWebhookRaw,
  slackTimestamp,
  slackUrlVerificationPayload,
} from "../support/webhook.js";

requireMinikubeContext();

/**
 * Ingress verification for every scheme the example EventSources use
 * (docs/event-triggers.md §1, §7). Verification happens on the RAW bytes,
 * BEFORE parsing; failure is 401; an unknown or wrong-kind source is 404.
 *
 * Every rejection is paired with an ACCEPTANCE using the same secret and an
 * event that matches no trigger, so it starts nothing. Without the pair a 401
 * proves only that SOMETHING was wrong -- a test signing with a stale secret
 * would see 401 for every case, "pass" every rejection, and cover nothing.
 *
 * Nothing here should ever start a turn; the last test asserts that, so a
 * rejected delivery that was relayed anyway turns this file red.
 */

/** Matches no example trigger (github-* key on issues/pull_request). */
const PING = { zen: "Keep it logically awesome.", hook_id: 1 };

describe(`webhook + tick verification (engine: ${deployedEngine()})`, () => {
  let startedAt: Date;
  let github: string;
  let slack: string;
  let ci: string;
  let hmac: string;
  let tick: string;

  beforeAll(async () => {
    startedAt = new Date();
    await ensureEventSecrets();
    [github, slack, ci, hmac, tick] = await Promise.all([
      githubWebhookSecret(),
      slackSigningSecret(),
      ciBearerToken(),
      genericHmacSecret(),
      tickToken("nightly-sweep"),
    ]);
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(startedAt);
  });

  describe("hmacSha256 (github: x-hub-signature-256)", () => {
    it("accepts a correct signature", async () => {
      expect((await withGateway((f) => postGithubDelivery(f, "ping", PING, github))).status).toBe(202);
    });

    it("401s a wrong secret, a missing header, a tampered body, and a missing prefix", async () => {
      await withGateway(async (f) => {
        expect((await postGithubDelivery(f, "ping", PING, "not-the-secret")).status).toBe(401);
        expect((await postWebhookRaw(f, "github", JSON.stringify(PING), { "x-github-event": "ping" })).status).toBe(401);
        // Signed over one body, sent with another: the raw-bytes property.
        const signed = JSON.stringify(PING);
        const sentBody = JSON.stringify({ ...PING, zen: "tampered" });
        expect(
          (await postWebhookRaw(f, "github", sentBody, {
            "x-github-event": "ping",
            "x-hub-signature-256": `sha256=${hmacSha256Hex(github, signed)}`,
          })).status,
        ).toBe(401);
        // The right hex without the configured prefix.
        expect(
          (await postWebhookRaw(f, "github", signed, {
            "x-github-event": "ping",
            "x-hub-signature-256": hmacSha256Hex(github, signed),
          })).status,
        ).toBe(401);
      });
    });

    it("verifies BEFORE parsing: an unparseable body with a bad signature is 401, not 400", async () => {
      const status = await withGateway(async (f) =>
        (await postWebhookRaw(f, "github", "{not json", { "x-hub-signature-256": "sha256=00" })).status,
      );
      expect(status).toBe(401);
    });
  });

  describe("hmacSha256 (generic-hmac: x-signature-256)", () => {
    it("accepts a correct signature and 401s a wrong or missing one", async () => {
      await withGateway(async (f) => {
        // {"nourl": ...} matches no trigger (generic-hmac-tool needs an https url).
        expect((await postHmacWebhook(f, "generic-hmac", { nourl: true }, hmac)).status).toBe(202);
        expect((await postHmacWebhook(f, "generic-hmac", { nourl: true }, "wrong")).status).toBe(401);
        expect((await postWebhookRaw(f, "generic-hmac", JSON.stringify({ nourl: true }))).status).toBe(401);
        // GitHub's header on this source is not this source's header.
        expect(
          (await postHmacWebhook(f, "generic-hmac", { nourl: true }, hmac, { header: "x-hub-signature-256" })).status,
        ).toBe(401);
      });
    });
  });

  describe("bearer (ci: Authorization: Bearer <token>)", () => {
    it("accepts the token and 401s a wrong, missing, or un-prefixed one", async () => {
      await withGateway(async (f) => {
        // status "success" matches no trigger (ci-failure-skill keys on failure statuses).
        const ok = { status: "success", repository: "e2e-org/e2e-repo", job: "verify" };
        expect((await postBearerWebhook(f, "ci", ok, ci)).status).toBe(202);
        expect((await postBearerWebhook(f, "ci", ok, `${ci}x`)).status).toBe(401);
        expect((await postBearerWebhook(f, "ci", ok, undefined)).status).toBe(401);
        expect((await postWebhookRaw(f, "ci", JSON.stringify(ok), { authorization: ci })).status).toBe(401);
      });
    });
  });

  describe("slackV0 (slack: x-slack-signature over v0:<ts>:<body>)", () => {
    it("answers url_verification with its challenge, synchronously, when signed", async () => {
      const challenge = `e2e-challenge-${Date.now()}`;
      const res = await withGateway((f) => postSlackEvent(f, slackUrlVerificationPayload(challenge), slack));
      expect(res.status).toBe(200);
      // Slack accepts the challenge as plain text or as {"challenge": ...}; either carries it.
      expect(res.text).toContain(challenge);
    });

    it("401s an unsigned url_verification -- the handshake is not a verification bypass", async () => {
      const res = await withGateway((f) =>
        postWebhookRaw(f, "slack", JSON.stringify(slackUrlVerificationPayload("e2e-unsigned"))),
      );
      expect(res.status).toBe(401);
      expect(res.text).not.toContain("e2e-unsigned");
    });

    it("accepts a fresh signature and 401s a wrong one and a stale timestamp", async () => {
      // reaction_added matches no trigger (slack-mention-chat keys on app_mention).
      const event = { type: "event_callback", event: { type: "reaction_added", user: "U0E2E", reaction: "eyes" } };
      await withGateway(async (f) => {
        expect((await postSlackEvent(f, event, slack)).status).toBe(202);
        expect((await postSlackEvent(f, event, "wrong-secret")).status).toBe(401);
        // Correctly SIGNED, but 10 minutes old: outside the 300s replay window.
        expect((await postSlackEvent(f, event, slack, { timestamp: slackTimestamp(-600) })).status).toBe(401);
        expect((await postWebhookRaw(f, "slack", JSON.stringify(event))).status).toBe(401);
      });
    });
  });

  describe("routing", () => {
    it("404s an unknown source, and a webhook POST to a cron source", async () => {
      await withGateway(async (f) => {
        expect((await postWebhookRaw(f, "e2e-no-such-source", "{}")).status).toBe(404);
        // nightly-sweep exists, but is cron: /webhooks/ is not its route (§7).
        expect((await postWebhookRaw(f, "nightly-sweep", "{}")).status).toBe(404);
      });
    });
  });

  describe("tick (/events/:source/tick): the source's own ServiceAccount, via the issuer keys", () => {
    // ServiceAccounts named like a tick identity for sources that are NOT
    // cron: they authenticate, so the gateway gets past token verification and must
    // still refuse on the source (404), never treat "valid SA" as "may tick".
    const impostors = ["eventsource-github", "eventsource-e2e-no-such-source"];

    beforeAll(async () => {
      for (const sa of impostors) {
        await kubectl(["create", "serviceaccount", sa]).catch(() => undefined);
      }
    });

    afterAll(async () => {
      for (const sa of impostors) {
        await kubectl(["delete", "serviceaccount", sa, "--ignore-not-found"]).catch(() => undefined);
      }
    });

    it("401s a tampered, missing, or wrong-audience token", async () => {
      const apiAudience = await mintServiceAccountToken("eventsource-nightly-sweep", "https://kubernetes.default.svc.cluster.local");
      await withGateway(async (f) => {
        expect((await postTick(f, "nightly-sweep", `${tick}x`)).status).toBe(401);
        expect((await postTick(f, "nightly-sweep", undefined)).status).toBe(401);
        // The right identity, minted for the API server: not for us.
        expect((await postTick(f, "nightly-sweep", apiAudience)).status).toBe(401);
      });
    });

    it("401s another source's valid identity -- one source can never tick another", async () => {
      const other = await mintServiceAccountToken("eventsource-github");
      await withGateway(async (f) => {
        expect((await postTick(f, "nightly-sweep", other)).status).toBe(401);
        // ...and nightly-sweep's own token cannot tick anything else either.
        expect((await postTick(f, "github", tick)).status).toBe(401);
      });
    });

    it("404s a tick on a webhook source and on an unknown source, from that name's own valid identity", async () => {
      // A valid token for the exact name is what makes these 404s meaningful:
      // an auth check that ran AFTER the kind check could not be told apart
      // otherwise. The positive tick (202 -> a turn) is event-triggers-cron.e2e.ts.
      const [github, missing] = await Promise.all(impostors.map((sa) => mintServiceAccountToken(sa)));
      await withGateway(async (f) => {
        expect((await postTick(f, "github", github)).status).toBe(404);
        expect((await postTick(f, "e2e-no-such-source", missing)).status).toBe(404);
      });
    });
  });

  it("started no turn: none of the deliveries above may have launched anything", async () => {
    await new Promise((r) => setTimeout(r, 20_000));
    expect((await agentRunDetailsSince(startedAt)).map((r) => `${r.name} (${r.agentRef})`)).toEqual([]);
  });
});
