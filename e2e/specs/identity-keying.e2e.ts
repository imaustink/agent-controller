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
import { identityLinkLogin, identityLinkTokenStatus } from "../support/gateway-api.js";
import {
  claudeCredentialSubjects,
  deleteCredentialKeys,
  githubLinkExpiry,
  seedAllClaudeCredentials,
  seedGithubLink,
} from "../support/redis.js";
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
      // Generous on purpose, and raised again (420s -> 900s) once
      // docs/adr/0031 made github links startable here: more turns park, and a
      // parked turn's relay is processed serially, so a positive webhook spec
      // waits behind them. Measured, not guessed -- one run authorized this
      // turn ~7 MINUTES after the webhook was posted, landing two seconds
      // inside the old budget on one run and outside it on the next.
      //
      // Two structural fixes were tried and did NOT hold: rolling the gateway
      // before each spec (the delay is per-turn processing, not stale state)
      // and running the parking negative controls last (the failure simply
      // moved to whichever positive ran first). The latency is real and lives
      // in the stack, not in the ordering, so the budget states it plainly
      // rather than a mitigation pretending to have removed it. What this spec
      // asserts is WHICH SUBJECT a credential is keyed under -- never how fast.
      { timeoutMs: 900_000 },
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
      // Generous on purpose, and raised again (420s -> 900s) once
      // docs/adr/0031 made github links startable here: more turns park, and a
      // parked turn's relay is processed serially, so a positive webhook spec
      // waits behind them. Measured, not guessed -- one run authorized this
      // turn ~7 MINUTES after the webhook was posted, landing two seconds
      // inside the old budget on one run and outside it on the next.
      //
      // Two structural fixes were tried and did NOT hold: rolling the gateway
      // before each spec (the delay is per-turn processing, not stale state)
      // and running the parking negative controls last (the failure simply
      // moved to whichever positive ran first). The latency is real and lives
      // in the stack, not in the ordering, so the budget states it plainly
      // rather than a mitigation pretending to have removed it. What this spec
      // asserts is WHICH SUBJECT a credential is keyed under -- never how fast.
      { timeoutMs: 900_000 },
    );
  });

});

describe("chat and triage converge on one credential (ADR 0031)", () => {
  const CHAT_USER = "e2e-chat-user";
  const CHAT_SUBJECT = chatSubject(CHAT_USER);
  /** Names the agent outright -- see this describe's doc on planner-driven selection. */
  const REQUEST = "Delegate this to stub-agent: fix the failing test in e2e-org/e2e-repo";
  /** Agents whose launch proves a principal-keyed credential resolved: the ones declaring `claude`/`claude-remote`. */
  const CREDENTIAL_AGENTS = ["stub-agent", "claude-code-swe-agent"];
  let suiteStartedAt: Date;

  /**
   * Waits for a launch and asserts it was an agent that actually needs the
   * credentials under test, so a planner mis-pick names itself rather than
   * surfacing as a missing-env-var failure.
   */
  async function expectCredentialAgent(startedAt: Date, what: string): Promise<{ name: string }> {
    const run = await waitFor(what, async () => (await agentRunsSince(startedAt))[0], { timeoutMs: 420_000 });
    const ref = await agentRunAgentRef(run.name);
    expect(CREDENTIAL_AGENTS, `planner selected ${ref}`).toContain(ref);
    return run;
  }

  beforeAll(() => {
    suiteStartedAt = new Date();
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  beforeEach(async () => {
    await resetFakeGithub();
    await deleteCredentialKeys("claudeAuth:*");
    await deleteCredentialKeys("claudeAuthLogin:*");
    await deleteCredentialKeys("identityLink:*");
    await deleteCredentialKeys("sess:*");
  });

  it("resolves a chat turn's credentials from the principal, not the openwebui subject", async () => {
    // Seeded ONLY at the canonical subject: if the chat path still keyed by its
    // own subject it would find nothing and park, so a launch is the proof.
    await seedGithubLink(CHAT_SUBJECT, SENDER);
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();

    await chatTurn(CHAT_USER, REQUEST);

    const run = await expectCredentialAgent(startedAt, "a chat-driven AgentRun to launch using the canonically-keyed credentials");
    const envNames = await agentRunSecretEnvNames(run.name);
    expect(envNames).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envNames).toContain("CLAUDE_LOGIN_CREDENTIALS_JSON");
    // The mapping stayed a mapping: the principal step is link-only, so no
    // GITHUB_TOKEN reaches the run and the agent's delegated-write path (the
    // observed production 401) stays unreachable.
    expect(envNames).not.toContain("GITHUB_TOKEN");
  });

  it("adopts a pre-principal credential instead of asking the human to authorize again", async () => {
    // The reported complaint, as a test: this human authorized from chat before
    // principals existed, so their credential sits under `openwebui:<id>`.
    // Converging must MOVE it, not re-prompt for it.
    await seedGithubLink(CHAT_SUBJECT, SENDER);
    await seedAllClaudeCredentials(CHAT_SUBJECT);
    const startedAt = new Date();

    await chatTurn(CHAT_USER, REQUEST);

    await expectCredentialAgent(startedAt, "the adopted credential to carry a launch with no re-authorization");

    // Moved, not copied. A leftover copy is the failure mode that matters: the
    // claude-remote write-back only ever writes the new key, so the old one
    // would rot and then fail whichever flow still read it.
    for (const kind of ["setup-token", "login"] as const) {
      const subjects = await claudeCredentialSubjects(kind);
      expect(subjects).toContain(CANONICAL);
      expect(subjects).not.toContain(CHAT_SUBJECT);
    }
  });

  it("does not let a chat caller's principal serve another human's credential", async () => {
    // The negative control for adoption. `perUser` permits moving THIS caller's
    // record; nothing may pull in one keyed to anyone else.
    await seedGithubLink(CHAT_SUBJECT, SENDER);
    await seedAllClaudeCredentials("github:someone-else");
    const startedAt = new Date();

    // The turn must not LAUNCH. How it declines is deliberately not asserted:
    // with nothing at this caller's principal the pre-flight tries to start a
    // Claude link, and that can either hold open waiting for the human (a park)
    // or fail fast when the PTY flow cannot start in this environment ("❌ fetch
    // failed"). Both are correct refusals, and an earlier version of this spec
    // pinned the park specifically -- so it failed on a run where the flow
    // errored quickly, reporting a security control as broken when it had held.
    //
    // `allowPark` therefore tolerates either shape, and the assertions below are
    // the actual property: nobody else's credential was used, and none was moved.
    await chatTurn(CHAT_USER, REQUEST, { allowPark: true, timeoutMs: 90_000 });

    expect(await agentRunsSince(startedAt)).toHaveLength(0);
    // And the other human's credential is untouched -- not moved, not deleted.
    expect(await claudeCredentialSubjects("login")).toContain("github:someone-else");
  });

  it("does not re-prompt a caller whose GitHub link has EXPIRED (docs/adr/0031)", async () => {
    // The bug this suite could not see, because it only ever seeded FRESH links.
    //
    // `getValidToken` returns nothing for a link whose access token expired and
    // cannot be refreshed, and the pre-flight read that as "no GitHub identity"
    // and offered a link -- while `waitForCompletion` resolved the same login
    // 0.3s later from the same record, so the turn then succeeded. Asserting on
    // the LAUNCH alone therefore passes either way; the prompt is the symptom, so
    // the prompt is what this asserts on.
    await seedGithubLink(CHAT_SUBJECT, SENDER, { expired: true });
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();

    const turn = await chatTurn(CHAT_USER, REQUEST);

    expect(turn.text).not.toMatch(/link your GitHub account/i);
    // And it still converged: an expired token does not unprove which account
    // this caller controls, so the principal resolves and the credentials at it
    // carry the launch.
    await expectCredentialAgent(startedAt, "an AgentRun launched from a stale-link caller's principal");
  });

  it("DOES prompt a caller who has no link at all, and launches nothing", async () => {
    // Two jobs. It is the control for the spec above -- without it, "no prompt in
    // the reply" would also pass if prompts stopped reaching the stream entirely
    // (a renamed stage, a changed transport), and the regression would be
    // invisible again. And it pins what "no link" MEANS.
    //
    // An earlier version of this suite asserted the opposite -- that such a caller
    // is launched on their own subject, sharing with nobody. That passed only
    // because `startAuthCode` 500'd here (no githubOauthRedirectUri configured),
    // so the pre-flight took its "could not start the link" DEGRADE path. With the
    // environment made faithful the real contract shows: a per-user caller who
    // needs a principal-keyed credential and has no mapping is asked to establish
    // one (docs/adr/0031), and the turn parks until they do. The degrade path
    // still exists for a link that genuinely cannot be started; it simply is not
    // what an unlinked caller hits.
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();

    const turn = await chatTurn(CHAT_USER, REQUEST, { allowPark: true, timeoutMs: 90_000 });

    expect(turn.text).toMatch(/link your GitHub account/i);
    // Nothing launched: with no principal, the credentials at CANONICAL are not
    // this caller's to use.
    expect(await agentRunsSince(startedAt)).toHaveLength(0);
  });

});

/**
 * A GitHub link renews itself instead of dying (docs/adr/0031).
 *
 * The second half of the same incident, and the cause of the first: the gateway
 * omitted `client_secret` from GitHub's refresh grant, which GitHub requires. So
 * every refresh failed, the caller read that as a dead link, and every link
 * expired ~8h after creation with a six-month-valid refresh token sitting unused.
 *
 * Asserted BEHAVIOURALLY rather than by inspecting the outgoing request:
 * `fake-github` now rejects a refresh grant that carries no `client_secret`,
 * exactly as GitHub does, so "the link came back usable" is only possible if the
 * secret was actually sent. A stub that accepted the call either way would let
 * this regress silently -- the entire failure was that the request looked fine
 * to us.
 */
describe("an expired GitHub link refreshes rather than reading as dead (ADR 0031)", () => {
  const SUBJECT = "openwebui:e2e-refresh-user";

  beforeEach(async () => {
    await resetFakeGithub();
    await deleteCredentialKeys("identityLink:*");
  });

  it("renews an expired link that still holds a refresh token", async () => {
    await seedGithubLink(SUBJECT, SENDER, { expired: true, refreshToken: true });
    const before = await githubLinkExpiry(SUBJECT);
    expect(before!.getTime()).toBeLessThan(Date.now());

    // 200, not 404: 404 is the gateway saying "dead link, make them re-link",
    // which is what every expired link used to get.
    expect(await identityLinkTokenStatus(SUBJECT)).toBe(200);

    const after = await githubLinkExpiry(SUBJECT);
    expect(after!.getTime()).toBeGreaterThan(Date.now());
    expect(after!.getTime()).toBeGreaterThan(before!.getTime());
  });

  it("reports the login for an expired link even when it cannot be refreshed", async () => {
    // No refresh token, so the credential genuinely cannot be recovered -- and
    // the IDENTITY still resolves. This is the separation the whole fix rests on:
    // an access token aging out does not unprove which account someone controls.
    await seedGithubLink(SUBJECT, SENDER, { expired: true });

    expect(await identityLinkTokenStatus(SUBJECT)).toBe(404);
    expect(await identityLinkLogin(SUBJECT)).toBe(SENDER);
  });

  it("404s the identity lookup when nothing is linked", async () => {
    expect(await identityLinkLogin("openwebui:nobody-at-all")).toBeUndefined();
  });
});
