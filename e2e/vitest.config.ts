import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["specs/**/*.e2e.ts"],
    // Serial, both levels. These share ONE cluster and several assert on
    // global state (Redis keys, the AgentRun list, fake-github's recorded
    // requests) that concurrent execution would race on -- a parallel run
    // fails in ways that look like product bugs.
    fileParallelism: false,
    maxConcurrency: 1,
    // A real triage turn launches a Job, pulls an image and runs an agent.
    // The per-step budgets in `waitFor` are the meaningful deadlines; this is
    // just a backstop well above them.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // One retry: cluster-level flakes (image pull backoff, a port-forward
    // dropped by a busy apiserver) are real and not worth a red build. Kept
    // at 1 so a genuinely broken assertion still fails fast rather than
    // being retried into looking intermittent.
    retry: 1,
  },
});
