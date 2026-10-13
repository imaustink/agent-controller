import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { cleanupAgentRunsSince, waitFor } from "../support/k8s.js";
import { resetFakeGithub } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { paceStubAgent, resetStubPacing } from "../support/resilience.js";
import { deployedEngine } from "../support/engine.js";
import {
  EXAMPLE_ACK_TEXT,
  STUB_REPLY_MARKER,
  githubWebhookSecret,
  issueActivity,
  parseRunFlagsLine,
  runJobFlags,
  waitForAgentRunWithParam,
  withGateway,
} from "../support/events.js";
import { issueLabeledPayload, postGithubDelivery } from "../support/webhook.js";

requireMinikubeContext();

/**
 * The `github-issue-triage` EventTrigger, end to end (docs/event-triggers.md,
 * charts/community-components/templates/eventtrigger-github-issue-triage.yaml).
 *
 * What used to be hardcoded gateway behaviour for the labeled path is now a
 * declarative `reply.github` block on an example CR, so each side-effect is
 * asserted as the CR declares it -- not as the old code happened to do it:
 *
 *   ack          "Starting work on this now." + session-page link, BEFORE the result
 *   result       the turn's result as a comment
 *   removeLabel  "{{label}}", on EVERY outcome, success or failure
 *
 * and the target is asserted as a run, not as a log line: `agentRef:
 * stub-agent` (values-e2e.yaml), NOT read-only, with the trigger's params on
 * `AgentRun.spec.params` and in the container (AGENT_PARAMS), echoed back by
 * the stub's `readOnly=... params=...` line.
 *
 * The `readOnly=false` assertions here are the negative half of
 * event-triggers-readonly.e2e.ts: if the readOnly plumbing ever defaulted to
 * true, every review assertion there would still pass -- these would not.
 */

const SENDER = "e2e-user";
const OWNER = "e2e-org";
const REPO = "e2e-repo";
const LABEL = "ai-triage";

/** values-e2e.yaml's idle window (agentIdleTimeoutSeconds / worker.idleTimeoutSeconds). */
const IDLE_WINDOW_MS = 30_000;

let counter = 0;
const BASE = 61_000 + (Date.now() % 30_000);
const nextIssue = () => BASE + counter++ * 211;

const ISSUE_TITLE = "e2e: triage me";
const ISSUE_BODY = "The widget is broken.";

/** The trigger's params for an issue, in their string form (§4) -- what AgentRun.spec.params must carry. */
function expectedParams(issue: number): Record<string, string> {
  return {
    description: ISSUE_BODY,
    label: LABEL,
    number: String(issue),
    repository: `${OWNER}/${REPO}`,
    title: ISSUE_TITLE,
  };
}

async function labelIssue(secret: string, issue: number): Promise<void> {
  const { status } = await withGateway((forward) =>
    postGithubDelivery(
      forward,
      "issues",
      issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber: issue, label: LABEL, senderLogin: SENDER, title: ISSUE_TITLE, body: ISSUE_BODY }),
      secret,
    ),
  );
  // §7: accepted deliveries are exactly 202 (relay continues in the background).
  expect(status).toBe(202);
}

describe(`EventTrigger github-issue-triage (engine: ${deployedEngine()})`, () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await githubWebhookSecret();
    await resetFakeGithub();
    await resetStubPacing();
    // stub-agent declares Claude providers; without a credential at the
    // sender's canonical subject the gate parks and nothing launches.
    await seedAllClaudeCredentials(`github:${SENDER}`);
  });

  afterAll(async () => {
    await resetStubPacing();
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  it("launches a writable stub-agent run with the trigger's params, acks first, posts the result, and removes the label", async () => {
    const issue = nextIssue();
    const startedAt = new Date();
    await labelIssue(secret, issue);

    const run = await waitForAgentRunWithParam(startedAt, "number", String(issue));
    // values-e2e.yaml: eventTriggers.githubIssueTriage.agentRef. Red if the
    // trigger's target stops being forced (a planner pick would differ).
    expect(run.agentRef).toBe("stub-agent");
    // Red if triage ever becomes read-only -- it must be able to push.
    expect(run.readOnly).toBe(false);
    expect(run.params).toEqual(expectedParams(issue));
    // promptTemplate was rendered with the params (single pass, §4).
    expect(run.goal).toContain(`GitHub issue ${OWNER}/${REPO}#${issue} was labeled "${LABEL}"`);
    expect(run.goal).not.toContain("{{");
    // The session the turn ran on: the trigger's sessionKey
    // "github:{{repository}}#{{number}}". Engine-specific only in WHERE it is
    // observable -- the LangGraph launcher stamps it on the run; the Temporal
    // launcher stamps nothing, so there it is pinned by
    // event-triggers-invoke.e2e.ts's trigger.sessionId instead.
    if (deployedEngine() === "langgraph") {
      expect(run.sessionAnnotation).toBe(`github:${OWNER}/${REPO}#${issue}`);
    }

    // §6 in the container's env, read while the Job still exists (TTL).
    const flags = await waitFor("the run's Job", async () => runJobFlags(run.jobName ?? run.name).catch(() => undefined), {
      timeoutMs: 120_000,
    });
    expect(flags.AGENT_READ_ONLY, "AGENT_READ_ONLY is set only on read-only runs").toBeUndefined();
    expect(JSON.parse(flags.AGENT_PARAMS ?? "null")).toEqual(expectedParams(issue));

    const result = await waitFor(
      `the stub's result comment on issue #${issue}`,
      async () => (await issueActivity(OWNER, REPO, issue)).comments.find((c) => c.text.includes(STUB_REPLY_MARKER)),
      { timeoutMs: 300_000 },
    );
    // What reached the container came back out of it, readOnly included.
    expect(parseRunFlagsLine(result.text)).toEqual({ readOnly: false, params: expectedParams(issue) });

    const activity = await waitFor(
      `the "${LABEL}" label to be removed from #${issue}`,
      async () => {
        const a = await issueActivity(OWNER, REPO, issue);
        return a.labelDeletes.length > 0 ? a : undefined;
      },
      { timeoutMs: 180_000 },
    );
    expect(activity.labelDeletes.map((d) => decodeURIComponent(d.path.split("/labels/")[1] ?? ""))).toContain(LABEL);

    // ack BEFORE result: fake-github records in arrival order. Red if the ack
    // moved after polling, or disappeared.
    const ackIndex = activity.comments.findIndex((c) => c.text.includes(EXAMPLE_ACK_TEXT));
    const resultIndex = activity.comments.findIndex((c) => c.text.includes(STUB_REPLY_MARKER));
    expect(ackIndex, "the ack comment was never posted").toBeGreaterThanOrEqual(0);
    expect(ackIndex).toBeLessThan(resultIndex);
    // sessionPage: true + GATEWAY_PUBLIC_URL set in values-e2e -> a link.
    expect(activity.comments[ackIndex]?.text).toMatch(/\/sessions\/[A-Za-z0-9_-]+/);
    // Exactly one ack and one result: a double relay would post twice.
    expect(activity.comments.filter((c) => c.text.includes(EXAMPLE_ACK_TEXT))).toHaveLength(1);
    expect(activity.comments.filter((c) => c.text.includes(STUB_REPLY_MARKER))).toHaveLength(1);
  });

  it("still acks, reports, and removes the label when the run FAILS", async () => {
    // Silence past the idle window is a failed turn (resilience.e2e.ts's
    // negative control). A failed run is exactly when someone re-applies the
    // label, so it must come off.
    await paceStubAgent({ silentForMs: IDLE_WINDOW_MS * 2 });
    const issue = nextIssue();
    const startedAt = new Date();
    try {
      await labelIssue(secret, issue);
      const run = await waitForAgentRunWithParam(startedAt, "number", String(issue));
      expect(run.readOnly).toBe(false);

      const activity = await waitFor(
        `label removal + a post-ack comment on failed #${issue}`,
        async () => {
          const a = await issueActivity(OWNER, REPO, issue);
          const ack = a.comments.findIndex((c) => c.text.includes(EXAMPLE_ACK_TEXT));
          const after = ack >= 0 ? a.comments.slice(ack + 1) : [];
          return a.labelDeletes.length > 0 && after.length > 0 ? { a, after } : undefined;
        },
        { timeoutMs: 420_000 },
      );
      // The post-ack comment reports the failure; it is NOT a stub reply
      // (the stub never answered). Red if a failed turn were reported as success.
      expect(activity.after.some((c) => c.text.includes(STUB_REPLY_MARKER))).toBe(false);
      expect(activity.a.labelDeletes.map((d) => decodeURIComponent(d.path.split("/labels/")[1] ?? ""))).toContain(LABEL);
    } finally {
      await resetStubPacing();
    }
  });
});
