import { beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { agentRunsSince, jobEnvNames, waitFor, withPortForward } from "../support/k8s.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";

// Module scope, before any fixture: a suite pointed at the wrong cluster must
// fail on import, not after it has started creating objects.
requireMinikubeContext();

const GATEWAY_PORT = 18090;
const OWNER = "e2e-org";
const REPO = "e2e-repo";

describe("happy path: GitHub issue label -> triage -> agent run -> comment posted", () => {
  let secret: string;

  beforeAll(async () => {
    secret = await webhookSecret();
    await resetFakeGithub();
  });

  it("runs the full chain and posts a comment back to the issue", async () => {
    const startedAt = new Date();
    const issueNumber = Math.floor(Date.now() / 1000) % 100000;

    const status = await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
      const res = await postGithubWebhook(
        baseUrl,
        "issues",
        issueLabeledPayload({
          owner: OWNER,
          repo: REPO,
          issueNumber,
          label: "ai-triage",
          senderLogin: "e2e-user",
        }),
        secret,
      );
      return res.status;
    });

    // The gateway acknowledges the webhook immediately and relays in the
    // background (a triage turn takes minutes), so a 2xx here means "accepted",
    // not "done". Everything real is asserted below by polling.
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);

    const run = await waitFor(
      "an AgentRun to be created for the labeled issue",
      async () => (await agentRunsSince(startedAt))[0],
      { timeoutMs: 180_000 },
    );

    // Env NAMES only -- never values (see jobEnvNames). Asserting the exact
    // ordered list rather than `toContain` is deliberate: duplicate env names
    // are legal in Kubernetes and the last wins, so a static `secretEnv`
    // shadowing a per-run identity override would slip past a containment
    // check while breaking the run.
    const envNames = await jobEnvNames(run.name);
    expect(envNames.filter((n) => n === "GITHUB_TOKEN")).toHaveLength(1);

    await waitFor(
      "the AgentRun to reach a terminal phase",
      async () => {
        const [current] = await agentRunsSince(startedAt);
        return current?.phase === "Succeeded" || current?.phase === "Failed" ? current : undefined;
      },
      { timeoutMs: 300_000 },
    );

    const comment = await waitFor(
      `a comment to be posted to issue #${issueNumber}`,
      async () => {
        const posted = (await fakeGithubRequests()).filter(
          (r) => r.method === "POST" && r.path === `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
        );
        return posted.length > 0 ? posted[posted.length - 1] : undefined;
      },
      { timeoutMs: 120_000 },
    );

    expect(comment?.body).toBeTruthy();
  });

  it("never calls an unstubbed GitHub endpoint", async () => {
    // fake-github 501s anything it doesn't know. If the system started
    // calling a new endpoint, this catches it as an explicit failure rather
    // than as a mystery 501 buried in an agent log.
    const unstubbed = (await fakeGithubRequests()).filter((r) => r.path.startsWith("/_e2e/") === false && r.status === 501);
    expect(unstubbed).toEqual([]);
  });
});
