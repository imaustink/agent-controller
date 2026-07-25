import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { agentRunSecretEnvNames, agentRunsSince, cleanupAgentRunsSince, waitFor, withPortForward } from "../support/k8s.js";
import { deleteCredentialKeys, seedAllClaudeCredentials } from "../support/redis.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { resetFakeGithub, webhookSecret } from "../support/fixtures.js";

requireMinikubeContext();

const GATEWAY_PORT = 18092;
const SENDER = "e2e-user";
const CANONICAL = `github:${SENDER}`;
/** What integration-gateway's own OIDC service token resolves to for EVERY webhook turn. */
const SHARED_SERVICE_SUBJECT = "client-integration-gateway";

/**
 * Issue numbers are unique per RUN, not fixed constants.
 *
 * A GitHub issue number is the session key for the whole triage flow
 * (`sess:github:<owner>/<repo>#<n>` in the orchestrator, plus the gateway's
 * own session-page record). Reusing a fixed number means the second run of a
 * spec inherits the first run's session state -- an active agent run, a
 * continuation -- and the turn takes a different path instead of launching
 * fresh. That produced a spec that passed once and then timed out on re-runs
 * while an identically-seeded sibling passed, which reads as product flakiness
 * but is entirely test-owned shared state.
 */
const RUN_ID = Date.now() % 100000;
const issueNo = (offset: number): number => RUN_ID + offset;

/**
 * The regression this suite exists for.
 *
 * A human authorized Claude during ai-triage, went to chat, and was asked to
 * authorize again -- `ClaudeTokenStore` keys by `identity.subject`, and the
 * webhook path (one shared OIDC service subject) and the chat path
 * (`openwebui:<id>`) resolve different ones. ADR 0029 converges both on a
 * canonical `github:<login>`; ADR 0030 decouples that from credential
 * provisioning.
 *
 * ## Why these assert on a LAUNCH rather than on a stored credential
 *
 * Starting a real `claude` flow needs the PTY-driven `claude login` and a paid
 * Anthropic credential, so "a credential appears under github:<login>" can
 * never happen hermetically. The assertion is inverted instead: seed a
 * credential at the subject the gate is believed to resolve, and require the
 * run to LAUNCH. A gate looking anywhere else finds nothing and parks, so the
 * launch is a precise, behavioural proof of which subject was used -- not a
 * log-scrape.
 */
describe("credential keying converges across entry points (ADR 0029/0030)", () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(() => {
    suiteStartedAt = new Date();
  });

  // Nothing else reclaims AgentRun CRs or their identity Secrets -- Jobs have
  // a TTL, these do not. Without this the suite leaves permanent residue that
  // every later `agentRunsSince` has to list and filter.
  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  beforeEach(async () => {
    secret = await webhookSecret();
    await resetFakeGithub();
    // Every test decides its own seeding, so start with nothing: a leftover
    // record is indistinguishable from a correctly-resolved one.
    await deleteCredentialKeys("claudeAuth:*");
    await deleteCredentialKeys("claudeAuthLogin:*");
    await deleteCredentialKeys("sess:*");
  });

  async function trigger(issueNumber: number, senderLogin: string): Promise<void> {
    await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
      const res = await postGithubWebhook(
        baseUrl,
        "issues",
        issueLabeledPayload({ owner: "e2e-org", repo: "e2e-repo", issueNumber, label: "ai-triage", senderLogin }),
        secret,
      );
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  }

  it("resolves a webhook turn's Claude credentials from github:<senderLogin>", async () => {
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();

    await trigger(issueNo(1), SENDER);

    // Launching proves the gate resolved BOTH claude providers -- it refuses
    // to launch otherwise -- and the only place those credentials exist is
    // the canonical subject.
    const run = await waitFor(
      "an AgentRun to launch using the canonically-keyed credentials",
      async () => (await agentRunsSince(startedAt))[0],
      // Generous on purpose. The negative-control specs above each leave the
      // gateway's relay polling for its full window, so a later positive spec
      // queues behind that backlog -- observed launch latency exceeded a
      // 180s budget even though the gate had already resolved. Too tight a
      // budget here fails for throughput reasons and reads as a keying bug.
      { timeoutMs: 420_000 },
    );

    // Asserted on the AgentRun CR -- agent-orchestrator's own output. Whether
    // core-controller then renders these into the Job's container env is that
    // controller's own contract, with its own tests; conflating the two makes
    // an orchestrator spec fail for a controller reason. (It was previously
    // observed NOT to happen on minikube. That turned out to be a stale
    // controller image, not a defect -- see controllers/core-controller/
    // .dockerignore -- and the happy-path spec asserts the rendered Job.)
    const envNames = await agentRunSecretEnvNames(run.name);
    expect(envNames).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envNames).toContain("CLAUDE_LOGIN_CREDENTIALS_JSON");
    // ADR 0030 §5: the orchestrator resolved WHO the caller is, so the agent
    // never calls GitHub's /user itself -- the call that 401'd in production.
    expect(envNames).toContain("AGENT_ACTOR_LOGIN");
  });

  it("does NOT resolve them from the shared service subject", async () => {
    // The negative control, and the actual bug. Before ADR 0029 every webhook
    // turn keyed on this one subject, so whoever authorized first silently
    // shared their Claude credential with every other user of the system.
    await seedAllClaudeCredentials(SHARED_SERVICE_SUBJECT);
    const startedAt = new Date();

    await trigger(issueNo(2), SENDER);

    // Give the turn real time to launch if it were going to; absence is the
    // assertion here, so it must not be a race.
    await new Promise((r) => setTimeout(r, 60_000));
    expect(await agentRunsSince(startedAt)).toHaveLength(0);
  });

  it("does not let one sender's credential satisfy another sender's turn", async () => {
    await seedAllClaudeCredentials("github:someone-else");
    const startedAt = new Date();

    await trigger(issueNo(3), SENDER);

    await new Promise((r) => setTimeout(r, 60_000));
    expect(await agentRunsSince(startedAt)).toHaveLength(0);
  });

  it("treats webhook casing and OAuth casing as one subject", async () => {
    // GitHub echoes original casing in webhooks but normalizes it in the OAuth
    // user API. Two casings keying two records is precisely the re-prompt loop
    // this all started from.
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();

    await trigger(issueNo(4), "E2E-User");

    await waitFor(
      "a mixed-case sender to resolve the lower-cased canonical credentials",
      async () => (await agentRunsSince(startedAt))[0],
      // Generous on purpose. The negative-control specs above each leave the
      // gateway's relay polling for its full window, so a later positive spec
      // queues behind that backlog -- observed launch latency exceeded a
      // 180s budget even though the gate had already resolved. Too tight a
      // budget here fails for throughput reasons and reads as a keying bug.
      { timeoutMs: 420_000 },
    );
  });
});
