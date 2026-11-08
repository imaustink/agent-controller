import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince, waitFor } from "../support/k8s.js";
import { resetFakeGithub } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { resetStubPacing } from "../support/resilience.js";
import { deployedEngine } from "../support/engine.js";
import {
  EXAMPLE_ACK_TEXT,
  agentRunDetailsSince,
  githubWebhookSecret,
  issueActivity,
  waitForAgentRunWithParam,
  withGateway,
} from "../support/events.js";
import { issueLabeledPayload, issueOpenedPayload, postGithubDelivery, pullRequestPayload } from "../support/webhook.js";

requireMinikubeContext();

/**
 * What must NOT start a turn, from the `github` EventSource.
 *
 * The gateway no longer filters (ADR 0048): it verifies, normalizes, resolves
 * the sender, and relays. So "does nothing" is now decided in two places, and
 * both are covered:
 *
 *   matching (orchestrator)  issues.opened, an unrelated label, pull_request.unlabeled,
 *                            pull_request.opened -- no trigger's CEL matches ->
 *                            `200 ignored`, no turn, NO RAG fallback
 *   sender   (gateway)       a Bot sender, or a login the GitHub provider cannot
 *                            resolve -> dropped before /invoke (a 202 + a log line,
 *                            so GitHub does not retry)
 *
 * Every delivery here is 202 -- the whole point is that an ACCEPTED delivery
 * can still be a clean no-op -- and the absence is asserted three ways: no
 * AgentRun, no ack comment, no label removal.
 *
 * An absence is only meaningful if the same window would have seen a presence,
 * so the file ENDS with a control: an otherwise identical matching delivery
 * that must launch and ack. And every sender used here has a seeded Claude
 * credential, so a delivery wrongly let through would LAUNCH rather than park
 * invisibly on a missing credential.
 */

const OWNER = "e2e-org";
const REPO = "e2e-repo";
const SENDER = "e2e-user";
/** Not in values-e2e.yaml's githubIdentities allowlist -> the GitHub sender provider resolves nothing. */
const STRANGER = "e2e-stranger";

/** Long enough for a wrongly-relayed delivery to have produced an ack and an AgentRun. */
const ABSENCE_WINDOW_MS = 75_000;

let counter = 0;
const BASE = 81_000 + (Date.now() % 15_000);
const next = () => BASE + counter++ * 97;

describe(`github deliveries that must not dispatch (engine: ${deployedEngine()})`, () => {
  let secret: string;
  let suiteStartedAt: Date;
  /** issue/PR number -> what was sent, for the failure message. */
  const sent = new Map<number, string>();

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await githubWebhookSecret();
    await resetFakeGithub();
    await resetStubPacing();
    await seedAllClaudeCredentials(`github:${SENDER}`);
    // Seeded so a stranger delivery that slipped through would launch visibly.
    await seedAllClaudeCredentials(`github:${STRANGER}`);
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  async function send(what: string, event: string, number: number, payload: unknown): Promise<void> {
    sent.set(number, what);
    const { status } = await withGateway((forward) => postGithubDelivery(forward, event, payload, secret));
    expect(status, `${what}: accepted deliveries are 202 even when nothing runs`).toBe(202);
  }

  it("accepts and ignores every non-matching or untrusted delivery", async () => {
    const startedAt = new Date();

    // ── no trigger matches ──
    const opened = next();
    await send("issues.opened, already carrying ai-triage", "issues", opened,
      issueOpenedPayload({ owner: OWNER, repo: REPO, issueNumber: opened, senderLogin: SENDER, labels: ["ai-triage"] }));
    const bug = next();
    await send("issues.labeled with an unrelated label", "issues", bug,
      issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: bug, label: "bug", senderLogin: SENDER }));
    const unlabeled = next();
    await send("pull_request.unlabeled ai-review", "pull_request", unlabeled,
      pullRequestPayload({ action: "unlabeled", owner: OWNER, repo: REPO, number: unlabeled, label: "ai-review", senderLogin: SENDER }));
    const prOpened = next();
    await send("pull_request.opened", "pull_request", prOpened,
      pullRequestPayload({ action: "opened", owner: OWNER, repo: REPO, number: prOpened, senderLogin: SENDER }));
    // The right label on the WRONG event header. The issue triggers' CEL keys
    // on headers["x-github-event"] == "issues", so they do not match; the PR
    // triage trigger's CEL DOES match (pull_request + labeled + ai-triage) but
    // its params read body.pull_request.*, which this body lacks -- a params
    // evaluation error after a match FAILS the event (422, §3), never a turn
    // run with empty values. Either way: no run, no comment.
    const wrongHeader = next();
    await send("issues-shaped ai-triage body under x-github-event: pull_request", "pull_request", wrongHeader,
      issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: wrongHeader, label: "ai-triage", senderLogin: SENDER }));

    // ── sender dropped by the gateway ──
    const bot = next();
    await send("ai-triage applied by a Bot sender", "issues", bot,
      issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: bot, label: "ai-triage", senderLogin: SENDER, senderIsBot: true }));
    const stranger = next();
    await send("ai-triage applied by an unresolvable sender", "issues", stranger,
      issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: stranger, label: "ai-triage", senderLogin: STRANGER }));

    await new Promise((r) => setTimeout(r, ABSENCE_WINDOW_MS));

    const runs = await agentRunDetailsSince(startedAt);
    expect(
      runs.map((r) => `${r.name} (${r.agentRef}, params.number=${r.params.number}: ${sent.get(Number(r.params.number)) ?? "?"})`),
      "a delivery that must not dispatch launched an AgentRun",
    ).toEqual([]);

    for (const [number, what] of sent) {
      const activity = await issueActivity(OWNER, REPO, number);
      expect(activity.comments.map((c) => c.text), `${what}: no comment may be posted`).toEqual([]);
      expect(activity.labelDeletes, `${what}: no label may be removed`).toEqual([]);
    }
  });

  it("control: the same window DOES see a matching delivery from a resolvable human", async () => {
    const issue = next();
    const startedAt = new Date();
    const { status } = await withGateway((forward) =>
      postGithubDelivery(
        forward,
        "issues",
        issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: issue, label: "ai-triage", senderLogin: SENDER }),
        secret,
      ),
    );
    expect(status).toBe(202);
    // If these time out, the absences above prove nothing about filtering.
    await waitForAgentRunWithParam(startedAt, "number", String(issue), ABSENCE_WINDOW_MS * 4);
    await waitFor(
      "the control's ack comment",
      async () => (await issueActivity(OWNER, REPO, issue)).comments.find((c) => c.text.includes(EXAMPLE_ACK_TEXT)),
      { timeoutMs: ABSENCE_WINDOW_MS * 2 },
    );
  });
});
