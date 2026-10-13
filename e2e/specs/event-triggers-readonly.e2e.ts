import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince, fetchThrough, waitFor } from "../support/k8s.js";
import { resetFakeGithub } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { resetStubPacing } from "../support/resilience.js";
import { deployedEngine } from "../support/engine.js";
import {
  EXAMPLE_ACK_TEXT,
  STUB_REPLY_MARKER,
  agentRunDetailsSince,
  githubWebhookSecret,
  issueActivity,
  parseRunFlagsLine,
  runJobFlags,
  waitForAgentRunWithParam,
  withGateway,
  type AgentRunDetail,
} from "../support/events.js";
import { issueLabeledPayload, postGithubDelivery, pullRequestPayload } from "../support/webhook.js";

requireMinikubeContext();

/**
 * `target.readOnly` is a STRUCTURED, DETERMINISTIC write gate (ADR 0048): the
 * review triggers carry it onto `AgentRun.spec.readOnly`, the controller turns
 * that into `AGENT_READ_ONLY=true` in the container, and the SWE agents enforce
 * read-only from that alone. It replaced the `SWE-ENFORCED-MODE: review-only`
 * prompt sentinel this suite used to grep chart templates for -- a write gate
 * riding on a string surviving an attacker-influenced body.
 *
 * Each hop is asserted where it is observable:
 *   CR        AgentRun.spec.readOnly          (the orchestrator's output, both engines)
 *   Job       AGENT_READ_ONLY=true            (core-controller's rendering)
 *   process   stub reply `readOnly=true ...`  (agent-runtime's session.readOnly)
 *
 * and against two controls that must read `false`: a triage run on a PR (here)
 * and on an issue (event-triggers-github.e2e.ts). Without them a readOnly that
 * defaulted to true everywhere would pass every assertion below.
 *
 * STICKY: readOnly is a session property. Once a review ran on
 * `github:<repo>#<n>`, every later turn on that session is read-only too --
 * including a triage label applied afterwards and a follow-up typed into the
 * session page. Both are asserted.
 *
 * The enforcement itself (denying `git push`, minting a contents:read token)
 * is proven hermetically in the SWE agents' own suites; what only a cluster can
 * show is that the flag ARRIVES.
 */

const SENDER = "e2e-user";
const OWNER = "e2e-org";
const REPO = "e2e-repo";
/** The /invoke caller every gateway-relayed turn without a verified sender runs as (values-e2e.yaml staticIdentities). */
const SHARED_SUBJECT = "client-integration-gateway";

let counter = 0;
const BASE = 71_000 + (Date.now() % 20_000);
const next = () => BASE + counter++ * 173;

const TITLE = "e2e: please review";
const BODY = "Proposal: do the thing.";

function params(number: number, label: string): Record<string, string> {
  return { description: BODY, label, number: String(number), repository: `${OWNER}/${REPO}`, title: TITLE };
}

async function deliver(secret: string, event: "issues" | "pull_request", number: number, label: string): Promise<void> {
  const payload =
    event === "issues"
      ? issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: number, label, senderLogin: SENDER, title: TITLE, body: BODY })
      : pullRequestPayload({ action: "labeled", owner: OWNER, repo: REPO, number, label, senderLogin: SENDER, title: TITLE, body: BODY });
  const { status } = await withGateway((forward) => postGithubDelivery(forward, event, payload, secret));
  expect(status).toBe(202);
}

/** The stub reply comment carrying a run-flags line, newest first after `afterIndex`. */
async function stubReplyOn(number: number, afterIndex = -1) {
  return waitFor(
    `a stub reply comment on #${number}`,
    async () => {
      const comments = (await issueActivity(OWNER, REPO, number)).comments;
      return comments.slice(afterIndex + 1).find((c) => c.text.includes(STUB_REPLY_MARKER));
    },
    { timeoutMs: 420_000 },
  );
}

async function assertReadOnlyAllTheWayDown(run: AgentRunDetail, expected: Record<string, string>, replyText: string) {
  expect(run.readOnly, `AgentRun ${run.name} spec.readOnly`).toBe(true);
  expect(run.params).toEqual(expected);
  const flags = await waitFor("the run's Job", async () => runJobFlags(run.jobName ?? run.name).catch(() => undefined), {
    timeoutMs: 120_000,
  });
  expect(flags.AGENT_READ_ONLY).toBe("true");
  expect(JSON.parse(flags.AGENT_PARAMS ?? "null")).toEqual(expected);
  expect(parseRunFlagsLine(replyText)).toEqual({ readOnly: true, params: expected });
}

describe(`EventTrigger target.readOnly reaches the run (engine: ${deployedEngine()})`, () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await githubWebhookSecret();
    await resetFakeGithub();
    await resetStubPacing();
    await seedAllClaudeCredentials(`github:${SENDER}`);
    // The session-page follow-up is relayed without a verified sender.
    await seedAllClaudeCredentials(SHARED_SUBJECT);
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  it("issue labeled ai-review -> github-issue-review: read-only on the CR, in the Job, and in the process", async () => {
    const issue = next();
    const startedAt = new Date();
    await deliver(secret, "issues", issue, "ai-review");

    const run = await waitForAgentRunWithParam(startedAt, "number", String(issue));
    // values-e2e.yaml: githubIssueReview.agentRef (production-shaped stub, declares `github`).
    expect(run.agentRef).toBe("stub-swe-agent");
    const reply = await stubReplyOn(issue);
    await assertReadOnlyAllTheWayDown(run, params(issue, "ai-review"), reply.text);
  });

  it("PR labeled ai-review -> github-pr-review is read-only; PR labeled ai-triage -> github-pr-triage is NOT (control)", async () => {
    const reviewPr = next();
    const triagePr = next();
    const startedAt = new Date();
    await deliver(secret, "pull_request", reviewPr, "ai-review");
    await deliver(secret, "pull_request", triagePr, "ai-triage");

    const review = await waitForAgentRunWithParam(startedAt, "number", String(reviewPr));
    const triage = await waitForAgentRunWithParam(startedAt, "number", String(triagePr));
    expect(review.agentRef).toBe("stub-agent");
    expect(triage.agentRef).toBe("stub-agent");

    await assertReadOnlyAllTheWayDown(review, params(reviewPr, "ai-review"), (await stubReplyOn(reviewPr)).text);

    // The control: same event type, same agent, different label -> writable.
    expect(triage.readOnly).toBe(false);
    const triageReply = await stubReplyOn(triagePr);
    expect(parseRunFlagsLine(triageReply.text)).toEqual({ readOnly: false, params: params(triagePr, "ai-triage") });
  });

  describe("sticky per session", () => {
    let issue: number;
    let reviewReplyIndex: number;

    beforeAll(async () => {
      // One review on a fresh issue; everything below continues ITS session
      // (`github:e2e-org/e2e-repo#<issue>`, both triggers' sessionKey).
      issue = next();
      const startedAt = new Date();
      await deliver(secret, "issues", issue, "ai-review");
      const run = await waitForAgentRunWithParam(startedAt, "number", String(issue));
      expect(run.readOnly).toBe(true);
      await stubReplyOn(issue);
      // Later replies on this issue are looked for strictly AFTER this one.
      reviewReplyIndex = (await issueActivity(OWNER, REPO, issue)).comments.findIndex((c) =>
        c.text.includes(STUB_REPLY_MARKER),
      );
    });

    it("a TRIAGE label applied after a review on the same issue still runs read-only", async () => {
      // github-issue-triage has no readOnly of its own -- on a fresh issue it
      // is writable (event-triggers-github.e2e.ts). Only the session can make
      // this run read-only, so a `true` here is the sticky flag and nothing else.
      const startedAt = new Date();
      await deliver(secret, "issues", issue, "ai-triage");
      const run = await waitForAgentRunWithParam(startedAt, "label", "ai-triage");
      expect(run.params.number).toBe(String(issue));
      expect(run.agentRef).toBe("stub-agent");
      const reply = await stubReplyOn(issue, reviewReplyIndex);
      await assertReadOnlyAllTheWayDown(run, params(issue, "ai-triage"), reply.text);
    });

    it("a follow-up prompt from the session page launches a read-only run too", async () => {
      // The ack carries the session-page link (reply.github.sessionPage).
      const ack = (await issueActivity(OWNER, REPO, issue)).comments.find((c) => c.text.includes(EXAMPLE_ACK_TEXT));
      const token = /\/sessions\/([A-Za-z0-9_-]+)/.exec(ack?.text ?? "")?.[1];
      expect(token, "the review's ack comment carries no session-page link").toBeTruthy();

      const startedAt = new Date();
      const status = await withGateway(async (forward) => {
        const res = await fetchThrough(forward, `/sessions/${token}/prompts`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            // Names the agent explicitly: the planner delegates to a stub only
            // when told to (stub-swe-agent's orchestratorPrompt), and the repo
            // is named for the Temporal engine's repository read gate.
            prompt: `Delegate this to stub-swe-agent: re-check the review of ${OWNER}/${REPO} issue #${issue}`,
          }).toString(),
          redirect: "manual",
        });
        return res.status;
      });
      expect(status).toBe(303);

      // Wait for the follow-up TURN to finish (the session page stops showing a
      // "working…" turn), not for a launch: whether this plain chat turn may
      // launch at all is the engine's repository read gate's call, not the
      // sticky flag's. The Temporal engine refuses it -- a session-page prompt
      // names no verified repository for a github-declaring agent (ADR 0042) --
      // while LangGraph has no such gate and launches.
      await waitFor(
        "the follow-up turn to finish on the session page",
        async () => {
          const page = await withGateway(async (forward) => (await fetchThrough(forward, `/sessions/${token}`)).text());
          return page.includes("re-check the review") && !page.includes("working…") ? true : undefined;
        },
        { timeoutMs: 420_000 },
      );

      // A plain conversational turn -- no trigger, so no params to match on;
      // any run launched since the prompt is this turn's (the suite is serial).
      // The invariant on BOTH engines: nothing it launched may be writable.
      const runs = await agentRunDetailsSince(startedAt);
      for (const run of runs) expect(run.readOnly, `AgentRun ${run.name} (${run.agentRef}) launched by the follow-up`).toBe(true);
      // Where the follow-up does launch (LangGraph), require that it did, so the
      // loop above is never vacuous there. Temporal's sticky flag for a
      // follow-up is pinned by TestReadOnlyIsStickyForTheConversation.
      if ((await deployedEngine()) === "langgraph") {
        expect(runs.length, "the LangGraph follow-up launched no AgentRun").toBeGreaterThan(0);
      }
    });
  });
});
