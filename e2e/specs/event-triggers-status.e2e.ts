import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { kubectl, kubectlJson } from "../support/k8s.js";
import { deployedEngine } from "../support/engine.js";
import {
  FIXTURE_LABEL,
  applyEventSource,
  applyEventTrigger,
  deleteEventFixtures,
  ensureEventSecrets,
  invokeEvent,
  runSuffix,
  upsertSecret,
  waitForReady,
  waitForTriggersLoaded,
  webhookEnvelope,
  withGateway,
} from "../support/events.js";
import { postHmacWebhook } from "../support/webhook.js";

requireMinikubeContext();

/**
 * `Ready` on EventSources and EventTriggers, and the promise it carries: a
 * trigger that is not Ready NEVER matches (fail closed, ADR 0048).
 *
 * The example CRs come from the same chart templating production uses, so a
 * template that rendered a broken CEL, a dangling ref, or a missing Secret turns
 * this red as a NAMED reason instead of as a silently-ignored delivery.
 *
 * Each NotReady case is proven to never match by posting the event it WOULD
 * match to /invoke and requiring `ignored` -- after a probe has confirmed the
 * orchestrator has loaded it (waitForTriggersLoaded), so the `ignored` cannot
 * be an informer race. Each is also paired with its recovery, so the reasons are
 * shown to be computed, not stuck.
 */

const FIXTURE = "status";
const ID = runSuffix();

const EXAMPLE_SOURCES: [string, string][] = [
  ["github", "Verifiable"],
  ["slack", "Verifiable"],
  ["ci", "Verifiable"],
  ["generic-hmac", "Verifiable"],
  ["nightly-sweep", "Scheduled"],
];

/** ci-failure-skill is excluded: it resolves only while event-triggers-reply-http.e2e.ts's fixture Skill exists. */
const EXAMPLE_TRIGGERS = [
  "github-issue-triage",
  "github-issue-review",
  "github-pr-triage",
  "github-pr-review",
  "slack-mention-chat",
  "generic-hmac-tool",
  "nightly-stale-sweep",
];

describe(`EventSource / EventTrigger status (engine: ${deployedEngine()})`, () => {
  beforeAll(async () => {
    await ensureEventSecrets();
  });

  afterAll(async () => {
    await deleteEventFixtures(FIXTURE);
  });

  describe("the shipped examples (examples/event-triggers, all applied by up.sh)", () => {
    it.each(EXAMPLE_SOURCES)("EventSource %s is Ready (%s)", async (name, reason) => {
      await waitForReady("eventsource", name, "True", reason, 60_000);
    });

    it.each(EXAMPLE_TRIGGERS)("EventTrigger %s is Ready (Resolved)", async (name) => {
      await waitForReady("eventtrigger", name, "True", "Resolved", 60_000);
    });

    // Successor to bridged-agent-review-readonly.e2e.ts, which grepped these
    // templates for the deleted `SWE-ENFORCED-MODE: review-only` sentinel. The
    // gate is a field now; a chart edit that dropped it would make every review
    // run writable while every runtime assertion on TRIAGE still passed.
    it("review / sweep / tool / ci triggers set target.readOnly; triage triggers do not", async () => {
      const readOnlyOf = async (name: string) =>
        (await kubectlJson<{ spec: { target: { readOnly?: boolean } } }>(["get", "eventtrigger", name])).spec.target.readOnly === true;
      for (const name of ["github-issue-review", "github-pr-review", "nightly-stale-sweep", "generic-hmac-tool", "ci-failure-skill"]) {
        expect(await readOnlyOf(name), `${name} must be read-only`).toBe(true);
      }
      for (const name of ["github-issue-triage", "github-pr-triage"]) {
        expect(await readOnlyOf(name), `${name} must be able to push`).toBe(false);
      }
    });
  });

  describe("EventTrigger reasons, and that NotReady never matches", () => {
    const match = (c: string) => ({ cel: `has(body.e2eStatus) && body.e2eStatus == "${ID}" && body.case == "${c}"` });
    const env = (c: string) => webhookEnvelope("generic-hmac", { e2eStatus: ID, case: c });
    const TARGET = { orchestrator: {}, promptTemplate: "Reply with the single word OK." };

    beforeAll(async () => {
      await applyEventTrigger(`e2e-st-badmatch-${ID}`, { sourceRef: "generic-hmac", match: { cel: "body.x == (" }, target: TARGET }, FIXTURE);
      // A VALID match with an invalid params expression: the one shape where
      // "never matches" is testable -- the event below satisfies the match.
      await applyEventTrigger(
        `e2e-st-badparams-${ID}`,
        { sourceRef: "generic-hmac", match: match("badparams"), params: { p: "body.((" }, target: TARGET },
        FIXTURE,
      );
      await applyEventTrigger(
        `e2e-st-notarget-${ID}`,
        { sourceRef: "generic-hmac", match: match("notarget"), target: { agentRef: `e2e-no-such-agent-${ID}`, promptTemplate: "x" } },
        FIXTURE,
      );
      await applyEventTrigger(
        `e2e-st-nosource-${ID}`,
        { sourceRef: `e2e-no-such-source-${ID}`, match: match("nosource"), target: TARGET },
        FIXTURE,
      );
    });

    it("invalid match CEL -> Ready=False InvalidCEL", async () => {
      const c = await waitForReady("eventtrigger", `e2e-st-badmatch-${ID}`, "False", "InvalidCEL");
      expect(c.message ?? "").toContain("match.cel");
    });

    it("invalid params CEL -> Ready=False InvalidCEL, naming the param", async () => {
      const c = await waitForReady("eventtrigger", `e2e-st-badparams-${ID}`, "False", "InvalidCEL");
      expect(c.message ?? "").toContain("params.p");
    });

    it("missing target -> TargetNotFound; missing source -> SourceNotFound", async () => {
      await waitForReady("eventtrigger", `e2e-st-notarget-${ID}`, "False", "TargetNotFound");
      await waitForReady("eventtrigger", `e2e-st-nosource-${ID}`, "False", "SourceNotFound");
    });

    it("none of them matches an event its match would accept", async () => {
      await waitForTriggersLoaded(FIXTURE);
      for (const c of ["badparams", "notarget"]) {
        const r = await invokeEvent(env(c));
        expect(r, `${c}: a NotReady trigger matched`).toMatchObject({ status: 200, body: { status: "ignored" } });
      }
    });

    it("recovers when fixed: retargeting the trigger at a real agent makes it Resolved -- and it then matches", async () => {
      // The control for the test above: the SAME trigger and envelope, once
      // Ready, is selected. Without this an orchestrator that matched nothing
      // at all would pass "never matches".
      await kubectl([
        "patch",
        "eventtrigger",
        `e2e-st-notarget-${ID}`,
        "--type",
        "merge",
        "-p",
        JSON.stringify({ spec: { target: { agentRef: null, orchestrator: {}, promptTemplate: "Reply with the single word OK." } } }),
      ]);
      await waitForReady("eventtrigger", `e2e-st-notarget-${ID}`, "True", "Resolved");
      await waitForTriggersLoaded(FIXTURE);
      const r = await invokeEvent(env("notarget"));
      expect(r.status).toBe(202);
      expect(r.body.trigger?.name).toBe(`e2e-st-notarget-${ID}`);
    });
  });

  describe("EventSource secret reasons", () => {
    const SOURCE = `e2e-st-src-${ID}`;
    const SECRET = `e2e-st-secret-${ID}`;

    it("SecretNotFound -> SecretKeyMissing -> Verifiable as the Secret appears and gains its key; never verifies meanwhile", async () => {
      await applyEventSource(
        SOURCE,
        { webhook: { verify: { scheme: "hmacSha256", header: "x-signature-256", prefix: "sha256=", secretRef: { name: SECRET, key: "secret" } } } },
        FIXTURE,
      );
      await waitForReady("eventsource", SOURCE, "False", "SecretNotFound");

      // A source with no usable secret must fail CLOSED at the gateway: never
      // a 202, whatever the signature (one made with an empty secret included).
      const unverifiable = await withGateway((f) => postHmacWebhook(f, SOURCE, { e2e: ID }, ""));
      expect(unverifiable.status, "a source without its Secret accepted a delivery").not.toBe(202);
      expect(unverifiable.status).toBeGreaterThanOrEqual(400);

      await upsertSecret(SECRET, "wrong-key", "x", { [FIXTURE_LABEL]: FIXTURE });
      await waitForReady("eventsource", SOURCE, "False", "SecretKeyMissing");

      await upsertSecret(SECRET, "secret", `e2e-${ID}`, { [FIXTURE_LABEL]: FIXTURE });
      await waitForReady("eventsource", SOURCE, "True", "Verifiable");
    });
  });

  describe("admission", () => {
    it("rejects an EventSource that is both webhook and cron, and a trigger with two targets", async () => {
      await expect(
        applyEventSource(
          `e2e-st-both-${ID}`,
          {
            webhook: { verify: { scheme: "bearer", secretRef: { name: "ci-event-source", key: "token" } } },
            cron: { schedule: "0 0 * * *" },
          },
          FIXTURE,
        ),
      ).rejects.toThrow();
      await expect(
        applyEventTrigger(
          `e2e-st-twotargets-${ID}`,
          { target: { orchestrator: {}, agentRef: "stub-agent", promptTemplate: "x" } },
          FIXTURE,
        ),
      ).rejects.toThrow();
      // Control: the same call shape with ONE target is accepted.
      await applyEventTrigger(`e2e-st-onetarget-${ID}`, { target: { orchestrator: {}, promptTemplate: "x" }, match: { cel: "false" } }, FIXTURE);
    });
  });
});
