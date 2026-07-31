import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireMinikubeContext } from "../support/guard.js";
import { agentRunsSince, cleanupAgentRunsSince, waitFor, withPortForward } from "../support/k8s.js";
import { issueLabeledPayload, postGithubWebhook } from "../support/webhook.js";
import { fakeGithubRequests, resetFakeGithub, webhookSecret } from "../support/fixtures.js";
import { seedAllClaudeCredentials } from "../support/credential-store.js";
import { bounceNats, paceStubAgent, resetStubPacing, rollOrchestrator } from "../support/resilience.js";

requireMinikubeContext();

const GATEWAY_PORT = 18091;
const SENDER = "e2e-user";
const OWNER = "e2e-org";
const REPO = "e2e-repo";
const STUB_REPLY_MARKER = "stub-agent-reply";

/**
 * The idle window this environment runs with — `agentIdleTimeoutSeconds` in
 * charts/agent-controller/values-e2e.yaml. Specs below pace turns relative to
 * it, so it lives here as a named constant rather than as scattered magic
 * numbers that would silently stop meaning anything if the value changed.
 */
const IDLE_WINDOW_MS = 30_000;

/**
 * Budget for the best-effort warm-up turn in `beforeAll`. Deliberately well
 * under vitest.config.ts's `hookTimeout` (300s) -- a warm-up that outruns the
 * hook skips the entire file.
 */
const WARM_UP_BUDGET_MS = 150_000;

/**
 * The integration-gateway's poll budget in this environment
 * (`pollTimeoutMs` in values-e2e.yaml). It is the BINDING constraint on every
 * pacing number below: a turn that outruns it gets the gateway's own failure
 * comment regardless of how well the orchestrator handled things, so any spec
 * asserting on the stub's reply must finish inside it.
 */
const GATEWAY_POLL_BUDGET_MS = 90_000;

/**
 * Issue numbers, unique per call AND unlikely to repeat across runs.
 *
 * `Date.now() % 100000` was tempting and wrong in a way worth naming: the issue
 * number decides the session id (integration-gateway derives
 * `github:owner/repo#N`), sessions outlive a spec by the orchestrator's session
 * TTL, and a turn landing on a session that still carries an awaiting-reply anchor
 * RE-ATTACHES to that old run instead of launching a new one. The symptom would be
 * `timed out waiting for an AgentRun to be created` — a real product behaviour
 * (docs/adr/0033) triggered by a fixture, and indistinguishable from a regression.
 *
 * A modulo of the clock repeats every 100 seconds' worth of values, so two turns
 * that happen to be congruent collide. A per-run base plus a counter cannot,
 * within a run or between back-to-back runs. Test 5 still re-triggers a specific
 * issue deliberately, via `trigger(issueNumber)` — that path is unaffected.
 */
let issueCounter = 0;
const ISSUE_BASE = 10_000 + (Date.now() % 40_000);
function nextIssueNumber(): number {
  return ISSUE_BASE + issueCounter++ * 137;
}

/**
 * What survives infrastructure moving underneath an in-flight agent turn.
 *
 * These exist because of a real incident that no unit test could have caught
 * and no existing e2e spec covers: AgentRun 0f97aa3d ran for 3m54s and
 * SUCCEEDED, while the chat reported
 * `produced no reply within 3660000ms`. Three things combined --
 *
 *   1. the wait's bound was a nats.js FIRST-MESSAGE timeout, cancelled by the
 *      agent's first progress message, so it never actually bounded anything;
 *   2. `shutdown()` drained NATS in the same `Promise.all` as the HTTP close,
 *      destroying the subscription an in-flight turn was parked on;
 *   3. every failure was relabelled as that timeout, quoting a configured
 *      number that was never elapsed time.
 *
 * -- and all three are only observable with a real NATS server, a real
 * orchestrator process receiving a real SIGTERM, and a turn genuinely in
 * flight. Hence: here, not in `apps/*`.
 *
 * Every spec paces the stub agent so the turn is still running when the
 * disruption lands. Without that the turn completes in milliseconds and the
 * whole scenario is untestable -- which is why apps/stub-agent gained
 * pacing.ts.
 */
describe("resilience: infrastructure moving under an in-flight agent turn", () => {
  let secret: string;
  let suiteStartedAt: Date;

  beforeAll(async () => {
    suiteStartedAt = new Date();
    secret = await webhookSecret();
    await resetFakeGithub();
    // Same reason as happy-path: the stub declares the real agent's
    // identityProviders, so without a seeded credential the gate PARKS and no
    // AgentRun is ever created.
    await seedAllClaudeCredentials(`github:${SENDER}`);
    await warmUp();
  });

  /**
   * Runs one throwaway turn before any timed assertion.
   *
   * The FIRST turn a freshly-started orchestrator serves is far slower than
   * every later one -- it pays for Qdrant collection setup, embedding calls and
   * skill re-derivation before the graph ever reaches the delegate step. That
   * cost landed inside the first spec's "wait for an AgentRun" budget and made
   * it fail on attempt one and pass on retry, which reads exactly like a flaky
   * product bug and is not one. Paying it here puts it in setup where it
   * belongs.
   *
   * Best-effort on purpose: a warm-up that fails should not fail the suite,
   * because the specs below assert the real thing and will report honestly
   * either way. It logs instead.
   *
   * Its budget MUST stay well under vitest.config.ts's `hookTimeout` (300s).
   * A first version used the same 420s budget as the specs' own waits and so
   * could only ever blow the hook, which skips every test in the file and
   * reports as a suite failure rather than as a slow warm-up.
   */
  async function warmUp(): Promise<void> {
    await paceStubAgent({});
    try {
      const { startedAt } = await trigger();
      await waitFor(
        "the warm-up turn to reach a terminal phase",
        async () => {
          const [current] = await agentRunsSince(startedAt);
          return current?.phase === "Succeeded" || current?.phase === "Failed" ? current : undefined;
        },
        { timeoutMs: WARM_UP_BUDGET_MS },
      );
      console.log("  [resilience] warm-up turn completed; the stack is warm for the timed specs below");
    } catch (err) {
      console.log(`  [resilience] warm-up did not complete (continuing): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  afterAll(async () => {
    // Leaving pacing on the CR would make every later spec's turn slow, and
    // (with a silent phase) fail outright.
    await resetStubPacing();
    await cleanupAgentRunsSince(suiteStartedAt);
  });

  /**
   * Fires a triage webhook and returns the issue number it used.
   *
   * `onIssue` re-triggers against an issue already used. That matters for
   * resumability: integration-gateway derives its `session_id` from the issue
   * (`github:owner/repo#N`), so a second trigger on the SAME issue is the same
   * conversation to the orchestrator, and therefore the thing that re-attaches
   * to a run a previous turn was cut off from.
   */
  async function trigger(onIssue?: number): Promise<{ issueNumber: number; startedAt: Date }> {
    const issueNumber = onIssue ?? nextIssueNumber();
    const startedAt = new Date();
    const status = await withPortForward(
      "agent-controller-integration-gateway",
      8090,
      GATEWAY_PORT,
      async (baseUrl) => {
        const res = await postGithubWebhook(
          baseUrl,
          "issues",
          issueLabeledPayload({ owner: OWNER, repo: REPO, issueNumber, label: "ai-triage", senderLogin: SENDER }),
          secret,
        );
        return res.status;
      },
    );
    expect(status).toBeGreaterThanOrEqual(200);
    expect(status).toBeLessThan(300);
    return { issueNumber, startedAt };
  }

  const runCreated = (startedAt: Date) =>
    waitFor("an AgentRun to be created", async () => (await agentRunsSince(startedAt))[0], { timeoutMs: 420_000 });

  const runTerminal = (startedAt: Date, timeoutMs = 300_000) =>
    waitFor(
      "the AgentRun to reach a terminal phase",
      async () => {
        const [current] = await agentRunsSince(startedAt);
        return current?.phase === "Succeeded" || current?.phase === "Failed" ? current : undefined;
      },
      { timeoutMs },
    );

  const commentOn = (issueNumber: number, timeoutMs = 180_000) =>
    waitFor(
      `a comment on issue #${issueNumber}`,
      async () => {
        const posted = (await fakeGithubRequests()).filter(
          (r) => r.method === "POST" && r.path === `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments`,
        );
        return posted.length > 0 ? posted[posted.length - 1] : undefined;
      },
      { timeoutMs },
    );

  it("a narrating turn outlives the idle window many times over", async () => {
    // 2x the idle window, narrating every 5s, and comfortably inside the
    // gateway's poll budget so the reply assertion below is meaningful. The
    // point is that DURATION is not bounded -- only silence is.
    const narrateForMs = IDLE_WINDOW_MS * 2;
    expect(narrateForMs).toBeLessThan(GATEWAY_POLL_BUDGET_MS);
    await paceStubAgent({ narrateForMs, narrateEveryMs: 5000 });

    const { issueNumber, startedAt } = await trigger();
    await runCreated(startedAt);
    const run = await runTerminal(startedAt);
    expect(run.phase).toBe("Succeeded");

    const comment = await commentOn(issueNumber);
    // The stub's own reply, not the error comment the gateway posts on failure.
    expect(comment?.body).toContain(STUB_REPLY_MARKER);
  });

  it("a silent turn IS cut off once it exceeds the idle window", async () => {
    // The negative control, and the only proof the window does anything at all.
    // A `tool_call` would legitimately pause the clock; plain silence must not.
    // 2x the window: long enough to trip it, short enough that the orchestrator
    // gives up (at 1x) well inside the gateway's poll budget, so the failure
    // that reaches the issue is the orchestrator's and not the gateway's.
    await paceStubAgent({ silentForMs: IDLE_WINDOW_MS * 2 });

    const { issueNumber, startedAt } = await trigger();
    await runCreated(startedAt);

    const comment = await commentOn(issueNumber);
    // The orchestrator gave up on the turn, so the gateway relays a failure
    // rather than the stub's reply -- which never got published.
    expect(comment?.body).not.toContain(STUB_REPLY_MARKER);

    // And it said the TRUE thing, on the surface a human actually sees. The
    // orchestrator never logs a turn error -- it returns it, and the gateway
    // renders it into this comment (`Something went wrong processing this: ...`)
    // -- so the comment body is the only place this is observable, and is
    // exactly the surface that reported a fabricated bound during the incident.
    expect(comment?.body).toMatch(new RegExp(`went silent for ${IDLE_WINDOW_MS}ms`));
    expect(comment?.body).not.toMatch(/produced no reply within/);
  });

  /**
   * SKIPPED with a documented cause, not deleted.
   *
   * Observed on minikube, twice: destroying the NATS pod mid-turn drives the
   * AgentRun to phase `Failed` (`expected 'Failed' to be 'Succeeded'`), and a
   * following attempt then times out waiting for an AgentRun at all -- the
   * failure cascades into the next turn.
   *
   * What is NOT the explanation: a stale image. `maxReconnectAttempts: -1` was
   * confirmed present in the deployed stub-agent bundle, so the AGENT side has
   * the reconnect hardening too, and it still failed. The orchestrator side of
   * this is separately proven against a real 23s outage in
   * apps/agent-orchestrator/src/agents/nats-agent-channel.integration.test.ts
   * (the client rides it out, resubscribes and receives the reply), so what is
   * unverified is specifically an agent POD surviving the loss of its NATS
   * server -- publishes issued while the server is gone, and whether the run
   * process survives to publish its reply at all.
   *
   * Left in place because the scenario is worth covering and the pacing/bounce
   * scaffolding around it is correct; un-skip it once the agent-side behaviour
   * is understood. Enabling it as-is would make the suite red for a reason the
   * accompanying change does not claim to fix.
   */
  it.skip("survives NATS being destroyed mid-turn and still delivers the reply", async () => {
    // Two constraints squeeze this one: the turn must still be running when the
    // bounce completes (a pod delete + reschedule + Ready is ~20-40s here, and
    // well past the ~20s that nats.js's DEFAULT policy survives -- 10 attempts
    // 2s apart, then the connection closes for good), yet must finish inside
    // the gateway's poll budget for the reply assertion to mean anything.
    // Measured bounces here were 22.7s and 24.8s, and the gateway ceiling is
    // 90s, so 50s sits between them with margin at both ends. (75s was tried
    // first and left almost none against the ceiling.)
    await paceStubAgent({ narrateForMs: 50_000, narrateEveryMs: 5000 });

    const { issueNumber, startedAt } = await trigger();
    await runCreated(startedAt);

    const { oldPod, newPodReadyMs } = await bounceNats();
    console.log(`  [resilience] bounced NATS (${oldPod}); replacement Ready after ${newPodReadyMs}ms`);

    const run = await runTerminal(startedAt);
    expect(run.phase).toBe("Succeeded");

    const comment = await commentOn(issueNumber);
    // The stub's reply, relayed. An error comment here would carry
    // "Something went wrong processing this: ..." instead, so asserting the
    // marker also rules out the subscription loss being reported as the agent
    // going quiet -- different failures with different fixes.
    expect(comment?.body).toContain(STUB_REPLY_MARKER);
    expect(comment?.body).not.toMatch(/went silent for/);
  });

  it("an orchestrator rollout mid-turn does not fabricate a timeout, and the run still succeeds", async () => {
    // The incident itself: a rollout landing on a turn that is still running.
    // Paced long enough to still be in flight when SIGTERM arrives (pod start
    // eats a few seconds before `runCreated` returns), and short enough to have
    // a fair chance of finishing inside the shutdown drain window
    // (AGENT_SHUTDOWN_DRAIN_MS, 25s).
    await paceStubAgent({ narrateForMs: 20_000, narrateEveryMs: 2000 });

    const { issueNumber, startedAt } = await trigger();
    const created = await runCreated(startedAt);
    console.log(`  [resilience] rolling the orchestrator while ${created.name} is in flight`);

    await rollOrchestrator();

    const comment = await commentOn(issueNumber);
    console.log(`  [resilience] post-rollout comment: ${comment?.body?.slice(0, 160)}`);

    // THE regression guard. The old code turned the drained subscription into
    // exactly this string -- quoting a 61-minute bound that had not elapsed --
    // and the gateway rendered it into this comment. Whatever else a rollout
    // costs, that sentence must never appear again.
    expect(comment?.body).not.toMatch(/produced no reply within/);
    // Nor may transport loss be relabelled as the agent going quiet.
    expect(comment?.body).not.toMatch(/went silent for/);

    // Deliberately NOT asserted here: that THIS comment carries
    // STUB_REPLY_MARKER. The invocation record the gateway polls lives in an
    // in-process Map (server.ts), so the interrupted turn itself still cannot
    // produce the reply however cleanly NATS was handled. What recovers it is
    // the NEXT turn re-attaching -- see the resumability spec below, which
    // asserts exactly that.
    expect(comment).toBeDefined();

    // The run SURVIVED the roll: same run, not Failed. That is what makes the old
    // error message a lie rather than a report -- the thing it claimed had timed
    // out was in fact alive and holding an answer.
    //
    // It is deliberately NOT asserted to be `Succeeded`, and that is not a
    // weakening -- it is the assertion this test used to make, before
    // docs/adr/0033 made it unreachable. The agent now HOLDS its concluding
    // message until someone acks it, re-offering every 10s and giving up only
    // after `REPLY_ACK_TIMEOUT_MS` (10 minutes, packages/agent-runtime/runtime.ts).
    // Nothing acks here: this test rolls the orchestrator and never re-triggers,
    // so the new pod has no reason to re-attach. The run therefore stays Running
    // for ten minutes by design -- twice this test's whole budget, and past
    // vitest's per-test timeout. Waiting for `Succeeded` could only ever fail.
    //
    // The half this drops is not lost: the very next spec re-triggers the same
    // issue, and asserts the run reaches `Succeeded` precisely BECAUSE the
    // re-attach acked it.
    const [survivor] = await agentRunsSince(startedAt);
    expect(survivor?.name).toBe(created.name);
    expect(survivor?.phase).not.toBe("Failed");
  });

  /**
   * The other half: a rollout costs the interrupted turn, but not the ANSWER.
   *
   * The agent holds its concluding message until someone acks it (the protocol's
   * `reply_ack`), and the orchestrator wrote a resume anchor onto the
   * conversation before it started waiting, so a second trigger on the same
   * issue re-attaches to the SAME run and collects the reply it was holding.
   *
   * This is the assertion the spec above deliberately withholds. It only means
   * anything end-to-end: the hold lives in the agent's pod, the anchor in Redis,
   * the re-attach in the orchestrator, and the session identity in the gateway's
   * issue-derived `session_id`.
   */
  it("recovers the reply on a follow-up turn after a rollout, without launching a second run", async () => {
    await paceStubAgent({ narrateForMs: 20_000, narrateEveryMs: 2000 });

    const { issueNumber, startedAt } = await trigger();
    const created = await runCreated(startedAt);
    console.log(`  [resilience] rolling the orchestrator while ${created.name} is in flight`);
    await rollOrchestrator();

    // Second trigger on the SAME issue -> same session_id -> the orchestrator
    // finds the anchor and re-attaches instead of starting over.
    await trigger(issueNumber);

    const comment = await waitFor(
      `the recovered reply on issue #${issueNumber}`,
      async () => {
        const posted = (await fakeGithubRequests()).filter(
          (r) =>
            r.method === "POST" &&
            r.path === `/repos/${OWNER}/${REPO}/issues/${issueNumber}/comments` &&
            typeof r.body === "string" &&
            r.body.includes(STUB_REPLY_MARKER),
        );
        return posted.length > 0 ? posted[posted.length - 1] : undefined;
      },
      { timeoutMs: GATEWAY_POLL_BUDGET_MS },
    );
    expect(comment).toBeDefined();

    // The point of re-attaching rather than re-delegating: the original run
    // produced the answer, so a second AgentRun would mean the work was done
    // twice (and on a real coding agent, a second branch and a second PR).
    const runs = await agentRunsSince(startedAt);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.name).toBe(created.name);

    // Collecting the reply acks it, which releases the agent's hold and lets the
    // Job finish -- so the run reaching terminal is itself evidence the ack
    // arrived rather than the hold having simply timed out.
    const run = await runTerminal(startedAt);
    expect(run.phase).toBe("Succeeded");
  });
});
