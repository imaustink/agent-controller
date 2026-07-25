import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import {
  agentRunSecretEnvNames,
  agentRunsSince,
  cleanupAgentRunsSince,
  jobEnvNames,
  waitFor,
  withPortForward,
} from "../support/k8s.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/redis.js";

// Module scope, before any fixture: a suite pointed at the wrong cluster must
// fail on import, not after it has started creating objects.
requireMinikubeContext();

const GATEWAY_PORT = 18090;
const SENDER = "e2e-user";
const OWNER = "e2e-org";
const REPO = "e2e-repo";

/**
 * Must match `STUB_REPLY_MARKER` in apps/stub-agent/src/reply.ts.
 *
 * Matched on instead of prose: the assertion has to distinguish "the stub
 * replied and the gateway relayed it" from "some comment appeared", and keying
 * that to a sentence produces a spec that breaks on a rewording.
 */
const STUB_REPLY_MARKER = "stub-agent-reply";

/**
 * The chain, end to end, with only the model turn replaced.
 *
 * This spec was skipped for one reason: a real `claude-code-swe-agent` run needs
 * a paid Anthropic credential, so in a hermetic cluster the AgentRun never
 * reached a terminal phase and nothing past the launch could be asserted.
 * `stub-agent` (apps/stub-agent) removes that blocker -- it speaks the real NATS
 * agent protocol and returns a canned reply -- so everything between the webhook
 * and the issue comment is now exercised for real:
 *
 *   webhook HMAC -> IntegrationRoute dispatch -> authorization pre-flight ->
 *   AgentRun CR -> hardened Job -> NATS ready/progress/reply -> gateway relay ->
 *   comment posted to the issue
 *
 * It deliberately does NOT re-assert credential KEYING; identity-keying.e2e.ts
 * owns that, including the negative controls. The overlap is only that both need
 * the gate to resolve, which is why this seeds too.
 */
describe("happy path: GitHub issue label -> triage -> agent run -> comment posted", () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await webhookSecret();
    await resetFakeGithub();
    // Without this the identity gate correctly PARKS -- stub-agent declares the
    // same Claude identityProviders as the agent it stands in for, and no
    // credential exists -- so no AgentRun is ever created and the chain cannot
    // be observed. See seedAllClaudeCredentials for why a real `claude login`
    // is impossible in a hermetic test.
    await seedAllClaudeCredentials(`github:${SENDER}`);
  });

  // Nothing else reclaims AgentRun CRs or their identity Secrets within the
  // controller's retention window; Jobs have a TTL, these do not.
  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  it("runs the full chain and posts the agent's reply back to the issue", async () => {
    const startedAt = new Date();
    // Unique per run: the issue number IS the session key, so a fixed one makes
    // a re-run inherit the previous run's session instead of starting fresh.
    const issueNumber = Date.now() % 100000;

    const status = await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
      const res = await postGithubWebhook(
        baseUrl,
        "issues",
        issueLabeledPayload({
          owner: OWNER,
          repo: REPO,
          issueNumber,
          label: "ai-triage",
          senderLogin: SENDER,
        }),
        secret,
      );
      return res.status;
    });

    // The gateway acknowledges the webhook immediately and relays in the
    // background, so a 2xx here means "accepted", not "done". Everything real
    // is asserted below by polling.
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);

    const run = await waitFor(
      "an AgentRun to be created for the labeled issue",
      async () => (await agentRunsSince(startedAt))[0],
      { timeoutMs: 420_000 },
    );

    // ADR 0030 §4/§5: what the pre-flight decided to inject, on the
    // orchestrator's own output.
    const crSecretEnv = await agentRunSecretEnvNames(run.name);
    expect(crSecretEnv).toContain("AGENT_ACTOR_LOGIN");

    // Env NAMES only -- never values (see jobEnvNames). Asserting the count
    // rather than mere containment is deliberate: duplicate env names are legal
    // in Kubernetes and the LAST one wins, so a static `secretEnv` shadowing a
    // per-run identity override would slip past a containment check while
    // breaking the run.
    //
    // That core-controller renders `spec.secretEnv` into the Job at all was
    // itself once in doubt -- it did not happen on minikube, which turned out to
    // be a stale controller image rather than a defect (controllers/
    // core-controller/.dockerignore). Asserting it here is what would catch a
    // recurrence.
    const envNames = await jobEnvNames(run.name);
    for (const name of crSecretEnv) {
      expect(envNames.filter((n) => n === name), `${name} should appear exactly once in the Job's env`).toHaveLength(1);
    }

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

    // The stub's own reply, relayed -- not just any comment. Without the marker
    // this passes on an error comment the gateway posts when a run FAILS, which
    // is the opposite of what the spec is for.
    expect(comment?.body).toContain(STUB_REPLY_MARKER);
    // The goal survived webhook -> route -> orchestrator -> AgentRun -> Job ->
    // NATS intact. The stub echoes it back; the triage prompt names the issue.
    expect(comment?.body).toContain(String(issueNumber));
    // ADR 0030 §5: the sealed actor context reached the container, not merely
    // the Job spec. Only the NAME is asserted -- the stub reports names only,
    // and this body is published to a GitHub issue.
    expect(comment?.body).toContain("AGENT_ACTOR_LOGIN");
  });

  it("never calls an unstubbed GitHub endpoint", async () => {
    // fake-github 501s anything it doesn't know. If the system started calling
    // a new endpoint, this catches it as an explicit failure rather than as a
    // mystery 501 buried in an agent log.
    const unstubbed = (await fakeGithubRequests()).filter((r) => r.path.startsWith("/_e2e/") === false && r.status === 501);
    expect(unstubbed).toEqual([]);
  });
});
