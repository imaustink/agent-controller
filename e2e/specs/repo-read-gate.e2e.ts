import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import {
  agentRunAgentRef,
  agentRunSecretEnvNames,
  agentRunsSince,
  cleanupAgentRunsSince,
  waitFor,
  withPortForward,
} from "../support/k8s.js";
import { chatSubject, chatTurn } from "../support/chat.js";
import { deleteCredentials, seedAllClaudeCredentials, seedGithubLink } from "../support/credential-store.js";
import { deleteRedisKeys } from "../support/redis.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";

requireMinikubeContext();

/**
 * The repository read gate (the Temporal engine's authz.gateRepository).
 *
 * The rule: an agent that works in a GitHub repository reads as the person who
 * asked and writes as the App, and if that person cannot read the repository,
 * the agent does not launch at all. stub-swe-agent declares the same providers
 * as claude-code-swe-agent, `github` included, so these turns take the path a
 * production SWE run takes.
 *
 * Two entry points, two sources of evidence, both covered:
 *  - chat: the repository comes out of the request, and the engine checks it
 *    with the caller's OWN GitHub token before anything starts;
 *  - webhook: the repository comes from the event, whose sender
 *    integration-gateway already checked, and no user token is ever involved
 *    (the webhook subject is shared, so one would be everyone's).
 *
 * fake-github gives e2e-org exactly one repository, `e2e-repo`, and answers 404
 * for any other repository under it (`e2e-private` among them), which is how
 * GitHub answers a token that cannot see a private repository.
 */

const SENDER = "e2e-user";
const CANONICAL = `github:${SENDER}`;
/** The token seedGithubLink stores; the read check must run on this one. */
const SEEDED_USER_TOKEN = "Bearer gho_e2e-seeded";
const GATEWAY_PORT = 18093;
const RUN_ID = Date.now() % 100000;
/** The e2e agent that declares `github`, and so passes through the gate. */
const GATED_AGENT = "stub-swe-agent";

describe("an agent that acts on GitHub launches only into a repository its caller can read", () => {
  const CHAT_USER = `e2e-gate-${RUN_ID}`;
  let suiteStartedAt: Date;

  function session(label: string): string {
    return `e2e-repo-gate-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** Waits out the window a launch would take to appear, then asserts none did. */
  async function expectNoLaunchSince(startedAt: Date, graceMs = 20_000): Promise<void> {
    await new Promise((r) => setTimeout(r, graceMs));
    expect((await agentRunsSince(startedAt)).map((r) => r.name)).toEqual([]);
  }

  async function expectSweLaunch(startedAt: Date, what: string): Promise<string> {
    const run = await waitFor(what, async () => (await agentRunsSince(startedAt))[0], { timeoutMs: 420_000 });
    expect(await agentRunAgentRef(run.name)).toBe(GATED_AGENT);
    return run.name;
  }

  /** The read checks the engine made against one repository, and whose token each used. */
  async function readChecksOf(repo: string): Promise<(string | null)[]> {
    return (await fakeGithubRequests()).filter((r) => r.method === "GET" && r.path === `/repos/${repo}`).map((r) => r.auth);
  }

  beforeAll(() => {
    suiteStartedAt = new Date();
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  beforeEach(async () => {
    await resetFakeGithub();
    await deleteCredentials();
    await deleteRedisKeys("sess:*");
    // Linked and authorized for everything, so the only thing that can stop a
    // launch is the read gate itself.
    await seedGithubLink(chatSubject(CHAT_USER), SENDER);
    await seedAllClaudeCredentials(CANONICAL);
  });

  describe("from chat", () => {
    it("launches into a repository the caller can read, checked with their own token", async () => {
      const startedAt = new Date();

      await chatTurn(CHAT_USER, "Delegate this to stub-swe-agent: fix the failing test in e2e-org/e2e-repo", {
        sessionId: session("readable"),
        allowPark: true,
        timeoutMs: 120_000,
      });

      const run = await expectSweLaunch(startedAt, "stub-swe-agent to launch into a readable repository");
      const env = await agentRunSecretEnvNames(run);
      expect(env, "the run is told which repository was checked").toContain("AGENT_TARGET_REPOSITORY");
      expect(env, "reads run as the caller").toContain("GITHUB_TOKEN");
      expect(await readChecksOf("e2e-org/e2e-repo")).toContain(SEEDED_USER_TOKEN);
    });

    it("launches nothing into a repository the caller cannot read", async () => {
      const startedAt = new Date();

      const turn = await chatTurn(
        CHAT_USER,
        "Delegate this to stub-swe-agent: fix the failing test in e2e-org/e2e-private",
        { sessionId: session("private"), allowPark: true, timeoutMs: 120_000 },
      );

      expect(turn.text).toMatch(/can't see `e2e-org\/e2e-private`/);
      // The refusal came from checking, with the caller's token, not from
      // never getting that far.
      expect(await readChecksOf("e2e-org/e2e-private")).toEqual([SEEDED_USER_TOKEN]);
      await expectNoLaunchSince(startedAt);
    });

    // Which refusal a user gets here depends on the model: asked which
    // repository (it extracted nothing), or told they can't see one (it
    // mistook a word for a repository name, which the read check then
    // rejected). The exact empty-extraction answer is pinned by the engine's
    // unit tests; what this pins end to end is that the turn is refused and
    // nothing launches either way.
    it("refuses rather than launching when the request names no repository", async () => {
      const startedAt = new Date();

      const turn = await chatTurn(CHAT_USER, "Delegate this to stub-swe-agent: fix the failing test", {
        sessionId: session("unnamed"),
        allowPark: true,
        timeoutMs: 120_000,
      });

      expect(turn.text).toMatch(/Which GitHub repository|can't see `e2e-org\//);
      await expectNoLaunchSince(startedAt);
    });

    it("resolves a bare repository name against the deployment's default owner", async () => {
      const startedAt = new Date();

      await chatTurn(CHAT_USER, "Delegate this to stub-swe-agent: fix the failing test in the e2e-repo repository", {
        sessionId: session("bare"),
        allowPark: true,
        timeoutMs: 120_000,
      });

      await expectSweLaunch(startedAt, "stub-swe-agent to launch into e2e-org/e2e-repo from its bare name");
      expect(await readChecksOf("e2e-org/e2e-repo")).toContain(SEEDED_USER_TOKEN);
    });
  });

  describe("from a webhook", () => {
    it("launches into the event's repository without ever touching a user GitHub token", async () => {
      const startedAt = new Date();
      const secret = await webhookSecret();

      await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
        const res = await postGithubWebhook(
          baseUrl,
          "issues",
          issueLabeledPayload({
            owner: "e2e-org",
            repo: "e2e-repo",
            issueNumber: RUN_ID,
            label: "ai-review",
            senderLogin: SENDER,
          }),
          secret,
        );
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
      });

      // Budget matches identity-keying's webhook specs, for the same measured
      // reason: a relayed turn queues behind any parked ones.
      const run = await waitFor(
        "stub-swe-agent to launch from the review webhook",
        async () => (await agentRunsSince(startedAt))[0],
        { timeoutMs: 900_000 },
      );
      expect(await agentRunAgentRef(run.name)).toBe(GATED_AGENT);

      const env = await agentRunSecretEnvNames(run.name);
      expect(env).toContain("AGENT_TARGET_REPOSITORY");
      expect(env, "a shared webhook subject must never hand a run a user's GitHub token").not.toContain("GITHUB_TOKEN");

      const requests = await fakeGithubRequests();
      expect(
        requests.filter((r) => r.path.startsWith("/login/")).map((r) => r.path),
        "no GitHub link may be started under the shared webhook subject",
      ).toEqual([]);
    });
  });
});
