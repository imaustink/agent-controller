/**
 * Keeps a failed test's cluster artifacts alive long enough to look at them.
 *
 * `cleanupAgentRunsSince` deletes every AgentRun (and its identity Secret) a
 * spec file created, and that deletion is load-bearing: cross-run residue is
 * what made these specs flaky originally, and `agentRunsSince` has to list and
 * filter every CR that has ever existed. None of that is in question for a spec
 * that PASSED.
 *
 * For one that failed it is actively harmful. The evidence a resilience or
 * keying failure turns on -- how many AgentRuns were created, which one the
 * conversation re-attached to, what the run's phase and Secret looked like --
 * lives in exactly the objects teardown removes, and it is gone before anyone
 * reads the failure. Reproducing then means re-running the spec with an
 * out-of-band probe polling the cluster, which is both slow and only catches
 * what the probe thought to sample.
 *
 * So: a file with a failing test keeps its artifacts, a file where everything
 * passed cleans up as before. The controller reclaims them on its own schedule
 * regardless (`DefaultAgentRunRetention`, 1 hour), so this defers cleanup
 * rather than leaking -- the residue this exists to avoid is bounded by that
 * window, not unbounded as it was before `cleanupAgentRunsSince` existed.
 *
 * Registered globally through `setupFiles` in vitest.config.ts, so the state is
 * per spec FILE -- the same granularity as the `afterAll` hooks that call the
 * cleanup.
 */

import { afterEach, type TestContext } from "vitest";

let sawFailure = false;

/**
 * True when this spec file should leave its AgentRuns behind.
 *
 * `E2E_KEEP_AGENT_RUNS=1` forces it on for a green run too, for the case where
 * you want to inspect what a passing turn actually produced.
 */
export function shouldRetainArtifacts(): boolean {
  return sawFailure || process.env.E2E_KEEP_AGENT_RUNS === "1";
}

/** Escape hatch for a spec that wants to retain deliberately. */
export function retainArtifacts(): void {
  sawFailure = true;
}

afterEach((ctx: TestContext) => {
  // `ctx.task.result.state` is vitest's own verdict for the test that just
  // ran, which is more reliable than inferring one from thrown errors: a
  // test that fails inside its own hooks still lands here as "fail".
  if (ctx.task.result?.state === "fail") sawFailure = true;
});
