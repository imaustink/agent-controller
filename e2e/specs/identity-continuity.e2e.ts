import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { agentRunAgentRef, agentRunsSince, cleanupAgentRunsSince, waitFor } from "../support/k8s.js";
import { chatTurn } from "../support/chat.js";
import { deleteCredentials, seedAllClaudeCredentials } from "../support/credential-store.js";
import { deleteRedisKeys } from "../support/redis.js";
import { resetFakeGithub } from "../support/fixtures.js";

requireMinikubeContext();

/**
 * What the Temporal engine gateway resolves a caller to when it presents only
 * the shared Open WebUI bearer and no per-user identity (values-e2e.yaml's
 * temporal-engine `defaultSubject`). Every credential seeded here lives under
 * it, so any launch in this file means a turn ran as the shared subject.
 */
const SHARED_SUBJECT = "client-integration-gateway";
/** Names the agent outright, like identity-keying's chat specs, so selection is not what's under test. */
const REQUEST = "Delegate this to stub-agent: fix the failing test in e2e-org/e2e-repo";
const CREDENTIAL_AGENTS = ["stub-agent", "claude-code-swe-agent"];
const LINK_PROMPT = /link your GitHub account/i;

/**
 * A parked chat turn keeps the identity of the human who sent it.
 *
 * The incident (bitovi, 2026-09-22): a chat user with no GitHub link asked
 * claude-code-swe-agent for a PR. The turn parked on the link, and the
 * orchestrator re-submitted it every 4s so it could resume without a
 * follow-up message. Each re-submission re-verified Open WebUI's forwarded
 * JWT, which Open WebUI mints with a 300s expiry. Five minutes in, it stopped
 * verifying, the re-submission went out with no caller identity, and the
 * engine resolved the shared bearer subject. That subject holds a Claude
 * credential and needs no GitHub link, so the pending-link resume replayed the
 * user's request on it and the agent opened a PR the user never linked for.
 *
 * Two independent defects, one spec each, plus the refusal that replaces the
 * silent fallback:
 *  - the orchestrator must carry the identity it resolved on arrival through
 *    every resume (TemporalEngine.autoResumeLink);
 *  - the engine must not let a different caller resume someone else's parked
 *    request (workflows/identity.go resumePendingLink).
 *
 * All assert on ABSENCE of a launch, so the first spec is the positive
 * control: it proves the seeded shared credential really does launch a turn
 * that is genuinely the shared subject's. Without it, "nothing launched" would
 * also pass if the seed were simply broken.
 */
describe("a parked chat turn keeps its caller's identity", () => {
  let suiteStartedAt: Date;

  function session(label: string): string {
    return `e2e-identity-continuity-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  /** A fresh Open WebUI user per test: never linked, so every turn of theirs parks on GitHub. */
  function unlinkedUser(label: string): string {
    return `e2e-continuity-${label}-${Date.now()}`;
  }

  /** Waits out the window a launch would take to appear, then asserts none did. */
  async function expectNoLaunchSince(startedAt: Date, graceMs = 20_000): Promise<void> {
    await new Promise((r) => setTimeout(r, graceMs));
    const runs = await agentRunsSince(startedAt);
    expect(runs.map((r) => r.name), "a turn ran as the shared subject").toEqual([]);
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
    await seedAllClaudeCredentials(SHARED_SUBJECT);
  });

  it("control: the shared subject's seeded credentials launch a turn that IS the shared subject's", async () => {
    const startedAt = new Date();

    await chatTurn("anonymous", REQUEST, {
      sessionId: session("control"),
      withoutUserJwt: true,
      allowPark: true,
      timeoutMs: 120_000,
    });

    const run = await waitFor("the shared subject's own turn to launch", async () => (await agentRunsSince(startedAt))[0], {
      timeoutMs: 420_000,
    });
    expect(CREDENTIAL_AGENTS).toContain(await agentRunAgentRef(run.name));
  });

  it("does not fall back to the shared subject when the forwarded JWT expires mid-wait", async () => {
    const startedAt = new Date();

    // 15s of JWT against a ~4s resume cadence: the old code's fourth or fifth
    // resume already went out unauthenticated. The turn is held for a minute
    // past expiry, so a regression has a dozen chances to launch.
    const turn = await chatTurn(unlinkedUser("expiry"), REQUEST, {
      sessionId: session("expiry"),
      jwtExpiresInSeconds: 15,
      allowPark: true,
      timeoutMs: 75_000,
    });

    // The turn really did park on the link and sit in the resume loop. Without
    // this, no launch could also mean the turn never got that far.
    expect(turn.text).toMatch(LINK_PROMPT);
    expect(turn.parked, "the turn should still be waiting on the user's link").toBe(true);

    await expectNoLaunchSince(startedAt);
  });

  it("does not let another caller on the same conversation resume someone else's parked request", async () => {
    const startedAt = new Date();
    const sessionId = session("hijack");

    const owner = await chatTurn(unlinkedUser("owner"), REQUEST, { sessionId, allowPark: true, timeoutMs: 30_000 });
    expect(owner.text).toMatch(LINK_PROMPT);

    // The same conversation, as the shared subject. Its own message asks for
    // nothing an agent would do; the old engine ignored it and replayed the
    // owner's parked REQUEST under this caller's credentials.
    await chatTurn("anonymous", "Reply with the single word: hello", {
      sessionId,
      withoutUserJwt: true,
      allowPark: true,
      timeoutMs: 60_000,
    });

    await expectNoLaunchSince(startedAt);
  });

  it("refuses a chat turn whose forwarded JWT has already expired, rather than running it as the shared subject", async () => {
    const startedAt = new Date();

    const turn = await chatTurn(unlinkedUser("expired"), REQUEST, {
      sessionId: session("expired"),
      jwtExpiresInSeconds: -60,
      timeoutMs: 60_000,
    });

    expect(turn.text).toMatch(/could not resolve caller identity/i);
    await expectNoLaunchSince(startedAt);
  });
});
