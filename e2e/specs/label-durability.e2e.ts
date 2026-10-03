import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { agentRunsSince, cleanupAgentRunsSince, waitFor, withPortForward } from "../support/k8s.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { paceStubAgent, resetStubPacing, rollGateway } from "../support/resilience.js";

requireMinikubeContext();

const GATEWAY_PORT = 18093;
const SENDER = "e2e-user";
const OWNER = "e2e-org";
const REPO = "e2e-repo";
const TRIGGER_LABEL = "ai-triage";

/** The idle window this environment runs with (`agentIdleTimeoutSeconds`, values-e2e.yaml). */
const IDLE_WINDOW_MS = 30_000;

let issueCounter = 0;
const ISSUE_BASE = 50_000 + (Date.now() % 40_000);
function nextIssueNumber(): number {
  return ISSUE_BASE + issueCounter++ * 137;
}

/**
 * Proves trigger-label removal is DETERMINISTIC AND DURABLE -- the headline
 * bug: it "only worked ~3/4 of the time" because removal was an in-process
 * `finally` on a detached, whole-turn background promise. If the
 * integration-gateway pod restarted/OOM'd mid-turn, that `finally` never ran
 * and nothing retried, so the label was stranded forever (a re-apply emits no
 * `labeled` event, so the issue could not be re-triaged by hand).
 *
 * Two guarantees, neither observable without a real gateway pod, a real
 * orchestrator, and a real (fake-)GitHub recording the DELETE:
 *
 *   1. the label comes off even on the UNHAPPY path (the run fails), and
 *   2. the label STILL comes off when the gateway is rolled mid-turn, healed by
 *      the replacement pod's startup + periodic reconciler
 *      (apps/integration-gateway/src/label-reconciler.ts).
 *
 * Mirrors resilience.e2e.ts's posture: pace the stub so the turn is still
 * running when the disruption lands, and assert on what fake-github actually
 * recorded.
 */
describe("label durability: a trigger label always comes off, even on the unhappy path and across a gateway restart", () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await webhookSecret();
    await resetFakeGithub();
    // The stub declares the real agent's identityProviders, so without a seeded
    // credential the gate PARKS and no AgentRun is ever created.
    await seedAllClaudeCredentials(`github:${SENDER}`);
  });

  afterAll(async () => {
    await resetStubPacing();
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  async function trigger(onIssue?: number): Promise<{ issueNumber: number; startedAt: Date }> {
    const issueNumber = onIssue ?? nextIssueNumber();
    const startedAt = new Date();
    const status = await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
      const res = await postGithubWebhook(
        baseUrl,
        "issues",
        issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber, label: TRIGGER_LABEL, senderLogin: SENDER }),
        secret,
      );
      return res.status;
    });
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    return { issueNumber, startedAt };
  }

  const runCreated = (startedAt: Date) =>
    waitFor("an AgentRun to be created", async () => (await agentRunsSince(startedAt))[0], { timeoutMs: 420_000 });

  /**
   * Waits for fake-github to have recorded a DELETE against this issue's labels
   * endpoint -- i.e. the gateway (its `finally`, its bounded retry, OR the
   * reconciler) actually removed the trigger label. The gateway URL-encodes the
   * label name into the path (github-client.ts), so match the stable prefix.
   */
  const labelRemoved = (issueNumber: number, timeoutMs = 300_000) =>
    waitFor(
      `the trigger label to be removed from issue #${issueNumber}`,
      async () => {
        const deletes = (await fakeGithubRequests()).filter(
          (r) =>
            r.method === "DELETE" &&
            typeof r.path === "string" &&
            r.path.startsWith(`/repos/${OWNER}/${REPO}/issues/${issueNumber}/labels/`),
        );
        return deletes.length > 0 ? deletes[deletes.length - 1] : undefined;
      },
      { timeoutMs },
    );

  it("removes the trigger label even when the turn FAILS (the label must come off so a re-apply re-triggers)", async () => {
    // Drive the orchestrator to give up on the turn: plain silence past the idle
    // window is a failure (see resilience.e2e.ts's negative control). A failed
    // run is exactly when someone wants to re-trigger, so the label MUST come off.
    await paceStubAgent({ silentForMs: IDLE_WINDOW_MS * 2 });

    const { issueNumber, startedAt } = await trigger();
    await runCreated(startedAt);

    const deleted = await labelRemoved(issueNumber);
    expect(deleted).toBeDefined();
  });

  it("removes a stranded trigger label after the gateway is ROLLED mid-turn (durable self-heal)", async () => {
    // A long narrating run so the turn is still in flight -- and the gateway's
    // in-process label-removal `finally` still pending -- when the pod is rolled
    // out from under it. Rolling the gateway drops that `finally` on the floor:
    // nothing in the OLD pod will ever remove the label.
    await paceStubAgent({ narrateForMs: 120_000, narrateEveryMs: 5000 });

    const { issueNumber, startedAt } = await trigger();
    await runCreated(startedAt);

    // The disruption: the pod holding the only in-process label-removal `finally`
    // for this turn goes away mid-flight.
    await rollGateway();

    // The REPLACEMENT pod heals it: its startup sweep (and then its periodic
    // reconciler) finds the owed removal in the durable outbox, confirms the run
    // is no longer live, and removes the stranded label idempotently. Generous
    // budget: this depends on the reconciler's interval/grace, not on the turn.
    const deleted = await labelRemoved(issueNumber, 600_000);
    expect(deleted).toBeDefined();

    // Idempotent: the heal must not depend on the original turn, and a second
    // removal of an already-gone label is a 404 == success, never an error that
    // would wedge the sweep.
    expect(deleted?.method).toBe("DELETE");
  });
});
