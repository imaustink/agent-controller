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
  deleteCredentials,
  githubLinkExpiry,
  hasGithubLink,
  seedAllClaudeCredentials,
  seedGithubLink,
} from "../support/credential-store.js";
import { deleteRedisKeys } from "../support/redis.js";
import { bounceRedis } from "../support/resilience.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";

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
    await deleteCredentials("claude-auth");
    await deleteRedisKeys("sess:*");
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
   * A fresh session id per CALL, distinct from CHAT_SUBJECT (the identity,
   * which several tests deliberately share). Session state (including any
   * PendingIdentityLink) keys off this, and every call in this describe
   * block used to omit it, silently sharing ONE conversation for the whole
   * file -- harmless before a resume could ever reuse an outstanding link,
   * and a real cross-test leak the moment it could: a still-open device
   * flow from an earlier test resolved instantly in a later one that never
   * started its own.
   *
   * Must vary per CALL, not just per test: a `label` alone repeats
   * identically across vitest's own automatic retry of a failed test, and a
   * retry that reuses its failed attempt's session inherits that attempt's
   * still-open device flow -- which now actually completes (fake-github
   * completes any poll instantly), turning a flaky first attempt into a
   * silently-different second one instead of a clean re-run.
   */
  function session(label: string): string {
    return `e2e-identity-keying-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

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
    await deleteCredentials();
    await deleteRedisKeys("sess:*");
  });

  it("resolves a chat turn's credentials from the principal, not the openwebui subject", async () => {
    // Seeded ONLY at the canonical subject: if the chat path still keyed by its
    // own subject it would find nothing and park, so a launch is the proof.
    await seedGithubLink(CHAT_SUBJECT, SENDER);
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();

    await chatTurn(CHAT_USER, REQUEST, { sessionId: session("principal-not-openwebui-subject") });

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

    await chatTurn(CHAT_USER, REQUEST, { sessionId: session("adopts-pre-principal") });

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
    await chatTurn(CHAT_USER, REQUEST, {
      sessionId: session("no-cross-human-credential"),
      allowPark: true,
      timeoutMs: 90_000,
    });

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

    const turn = await chatTurn(CHAT_USER, REQUEST, { sessionId: session("expired-link-no-reprompt") });

    expect(turn.text).not.toMatch(/link your GitHub account/i);
    // And it still converged: an expired token does not unprove which account
    // this caller controls, so the principal resolves and the credentials at it
    // carry the launch.
    await expectCredentialAgent(startedAt, "an AgentRun launched from a stale-link caller's principal");
  });

  it("resumes a device-flow link by redeeming the SAME code instead of starting a new one", async () => {
    // The reported bug, reproduced: a caller with no live channel gets the
    // DEVICE flow (a code to enter wherever they are), and "send any message
    // once you're done" is what resumes it. Two things had to be true for
    // that resume to ever work, and both were broken:
    //
    //  1. Authorize must re-check the SAME outstanding flow, not start a
    //     second one -- it had no memory of a flow it already started, so
    //     every resume called Start again and handed the caller a brand-new
    //     code, orphaning whatever they were mid-way through entering.
    //  2. Something must actually POLL GitHub to redeem that code -- nothing
    //     ever did (upstream's LangGraph orchestrator polls on resume;
    //     the port to this engine dropped it), so even a caller who
    //     correctly entered their code on GitHub's page would sit there
    //     forever, re-shown the same dead prompt with no way to ever
    //     progress.
    //
    // fake-github completes a device code on its very first poll, so a
    // resume that reaches the poll at all should launch immediately.
    await seedAllClaudeCredentials(CANONICAL);
    const startedAt = new Date();
    const sessionId = `e2e-resume-anchor-${Date.now()}`;

    const first = await chatTurn(CHAT_USER, REQUEST, { sessionId, allowPark: true, timeoutMs: 120_000 });
    expect(first.text).toMatch(/link your GitHub account/i);
    expect(first.text).toMatch(/enter code/i);

    await chatTurn(CHAT_USER, "done", { sessionId, allowPark: true, timeoutMs: 120_000 });

    const deviceCodeStarts = (await fakeGithubRequests()).filter(
      (r) => r.method === "POST" && r.path === "/login/device/code",
    );
    expect(deviceCodeStarts, "the resume must re-check the SAME flow, never starting a second one").toHaveLength(1);

    await expectCredentialAgent(startedAt, "a launch once the resume actually redeemed the device code");
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

    const turn = await chatTurn(CHAT_USER, REQUEST, {
      sessionId: session("no-link-at-all"),
      allowPark: true,
      timeoutMs: 90_000,
    });

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
    await deleteCredentials("identity-link");
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

/**
 * The credential store outlives the infrastructure it runs alongside
 * (docs/adr/0034).
 *
 * This is the spec the reported incident needed and no existing one covered.
 * Every keying spec above seeds a credential and asserts WHERE it is read from,
 * which is exactly the right question and completely blind to the one that
 * actually broke: whether it is still there at all. The store was Redis, that
 * Redis runs with `--save "" --appendonly no` on an emptyDir, its pod restarted,
 * and every credential in the cluster was gone. The pre-flight then behaved
 * perfectly -- resolved the right principal, looked under it, found nothing --
 * and asked a user who had authorized months earlier to authorize again.
 *
 * Which is why the assertion is deliberately made ACROSS a real pod deletion
 * rather than against a store abstraction: nothing observable in-process
 * distinguishes "durable" from "durable until this pod moves". Redis is left
 * ephemeral on purpose. The credentials are not in it any more, and that is the
 * property under test.
 */
describe("linked credentials survive a Redis restart (ADR 0034)", () => {
  const CHAT_USER = "e2e-durability-user";
  const SUBJECT = chatSubject(CHAT_USER);
  const REQUEST = "Delegate this to stub-agent: fix the failing test in e2e-org/e2e-repo";
  /** Either agent proves the point -- both declare the Claude providers the gate resolves. */
  const CREDENTIAL_AGENTS = ["stub-agent", "claude-code-swe-agent"];
  let suiteStartedAt: Date;

  /** Local mirror of the sibling block's helper; the constants above are block-scoped. */
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
    await deleteCredentials();
    await deleteRedisKeys("sess:*");
  });

  it("keeps both Claude credentials and the GitHub link across the restart", async () => {
    await seedGithubLink(SUBJECT, SENDER);
    await seedAllClaudeCredentials(CANONICAL);

    expect(await claudeCredentialSubjects("setup-token")).toContain(CANONICAL);
    expect(await claudeCredentialSubjects("login")).toContain(CANONICAL);
    expect(await hasGithubLink(SUBJECT)).toBe(true);

    const { oldPod, newPodReadyMs } = await bounceRedis();
    console.log(`  [durability] replaced Redis pod ${oldPod}; new pod Ready in ${newPodReadyMs}ms`);

    // Before ADR 0034 all three of these were empty here, which is the whole
    // incident in three assertions.
    expect(await claudeCredentialSubjects("setup-token")).toContain(CANONICAL);
    expect(await claudeCredentialSubjects("login")).toContain(CANONICAL);
    expect(await hasGithubLink(SUBJECT)).toBe(true);
  });

  it("still authorizes a turn after the restart instead of asking for a re-link", async () => {
    // The behavioural half. Surviving as a stored record is necessary but not
    // sufficient -- the gateway has to still READ it after its own connection to
    // the vanished pod broke, which is the failure mode a store-level assertion
    // alone would miss.
    await seedGithubLink(SUBJECT, SENDER);
    await seedAllClaudeCredentials(CANONICAL);
    await bounceRedis();

    const startedAt = new Date();
    await chatTurn(CHAT_USER, REQUEST);

    // A launch is the proof: the gate refuses to launch without both Claude
    // credentials resolved, so reaching an AgentRun means it found them where
    // the restart was supposed to have destroyed them.
    const run = await expectCredentialAgent(
      startedAt,
      "an AgentRun to launch on credentials that outlived the Redis restart",
    );
    const envNames = await agentRunSecretEnvNames(run.name);
    expect(envNames).toContain("CLAUDE_CODE_OAUTH_TOKEN");
    expect(envNames).toContain("CLAUDE_LOGIN_CREDENTIALS_JSON");
  });
});

/**
 * A turn that needs more than one credential asks for all of them ONCE.
 *
 * The regression, in the user's words: "I was prompted to auth in the triage
 * flow, I authed and then was asked to auth again." What they actually received
 * was two comments, three minutes apart, for two DIFFERENT credentials that were
 * both called "Claude":
 *
 *   12:42 "please link your Claude account ... I also couldn't start the
 *          Claude linking step just now"
 *   12:45 "please link your Claude account"
 *
 * The cause was resource exhaustion, not keying. `@kubernetes/client-node` (~88
 * MiB RSS, added when credentials moved into Secrets) took the gateway to 255.1
 * MiB of a 256 MiB limit -- `memory.events` recorded 20 forced reclaims, and
 * nothing was OOM-killed, so there was no crash to notice. The second `claude`
 * PTY then spawned into a cgroup with no headroom and printed nothing within its
 * 30s authorize-URL timeout, so ADR 0030 §4's "start every missing link on ONE
 * turn" quietly became two turns.
 *
 * ## Why this spec can catch it where a unit test cannot
 *
 * Because it needs a real container with a real memory limit. The e2e deployment
 * takes the chart's DEFAULT resources -- the same ones production was running --
 * and `claudeAuth.enabled` means the flows spawn real `claude` processes. So two
 * PTYs really do have to coexist here, and if the limit is ever squeezed back to
 * where one of them cannot start, this fails. The unit tests
 * (authorization-service.test.ts) cover the retry and the wording; only this
 * covers whether the environment can actually do it.
 *
 * Asserts on the POSTED COMMENT rather than a log line: what went wrong was what
 * the human was asked to do, and the comment is that.
 */
describe("a turn needing two credentials asks for both at once (ADR 0030 §4)", () => {
  const OWNER = "e2e-org";
  const REPO = "e2e-repo";
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await webhookSecret();
  });

  afterAll(async () => {
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  beforeEach(async () => {
    await resetFakeGithub();
    // Nothing seeded: BOTH Claude link flows must be started for real, which is
    // the condition that needs two `claude` PTYs alive at once.
    await deleteCredentials();
    await deleteRedisKeys("sess:*");
  });

  it("offers both Claude link steps in a single comment, naming them distinctly", async () => {
    const issueNumber = issueNo(50);

    await withPortForward("agent-controller-integration-gateway", 8090, GATEWAY_PORT, async (baseUrl) => {
      const res = await postGithubWebhook(
        baseUrl,
        "issues",
        issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber, label: "ai-triage", senderLogin: SENDER }),
        secret,
      );
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });

    const comment = await waitFor(
      "the link-required comment to be posted to the issue",
      async () => {
        const posted = (await fakeGithubRequests()).filter(
          (r) =>
            r.method === "POST" &&
            r.path === `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments` &&
            typeof r.body === "string" &&
            r.body.includes("link your"),
        );
        return posted.length > 0 ? posted[posted.length - 1] : undefined;
      },
      // Both PTY flows have to spawn and print a URL, each bounded by its own 30s
      // timeout, behind whatever else is queued -- see the sibling suite's note on
      // why webhook budgets here are large and measured rather than guessed.
      { timeoutMs: 420_000 },
    );

    const body = String(comment!.body);

    // The assertion that would have failed in production: one comment covering
    // BOTH credentials, rather than one credential now and one a turn later.
    expect(body).toContain("2 accounts");
    expect(body).toContain("Claude Remote Control");
    // ...and no "I couldn't start" clause, which is what deferred a provider to a
    // later turn and produced the second prompt.
    expect(body).not.toContain("couldn't start");
  });
});
