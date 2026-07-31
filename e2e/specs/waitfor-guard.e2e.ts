import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRunsSince, waitFor } from "../support/k8s.js";

/**
 * `waitFor`'s own guarantee, checked with no cluster.
 *
 * This exists because the guarantee was silently broken and cost a full run to
 * notice. `waitFor` used to `await probe()` unbounded, so a probe that never
 * settled made `timeoutMs` unreachable: the loop stopped forever without
 * re-checking the deadline. That is not hypothetical — several probes `fetch`
 * through a `kubectl port-forward`, Node's fetch has no default timeout, and a
 * dropped forward leaves a socket nobody answers. A resilience run sat at 0% CPU
 * for eight silent minutes on exactly that, and reported nothing about which hop
 * stalled.
 *
 * Deliberately no `requireMinikubeContext()`: this touches nothing, so it runs
 * anywhere and fails fast if the guarantee regresses.
 */
describe("waitFor bounds every probe attempt", () => {
  it("still times out when the probe never settles", async () => {
    const started = Date.now();
    await expect(
      waitFor("a probe that never settles", () => new Promise<never>(() => {}), {
        timeoutMs: 3_000,
        intervalMs: 200,
        probeTimeoutMs: 500,
      }),
    ).rejects.toThrow(/hung and were abandoned/);
    // Bounded by `timeoutMs`, not by a probe that would have waited forever.
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("reports hung attempts distinctly from a condition that was merely never true", async () => {
    // "all attempts hung" and "the thing never happened" need different fixes, so
    // the message has to tell them apart.
    await expect(
      waitFor("a condition that is never true", async () => undefined, { timeoutMs: 600, intervalMs: 100 }),
    ).rejects.toThrow(/attempts\)/);
  });

  it("returns the probe's value as soon as it is non-nullish", async () => {
    let calls = 0;
    const value = await waitFor("a condition that becomes true", async () => (++calls >= 2 ? "ready" : undefined), {
      timeoutMs: 5_000,
      intervalMs: 50,
    });
    expect(value).toBe("ready");
    expect(calls).toBe(2);
  });

  it("surfaces a throwing probe's last error in the timeout message", async () => {
    await expect(
      waitFor("a probe that always throws", async () => {
        throw new Error("kubectl said no");
      }, { timeoutMs: 600, intervalMs: 100 }),
    ).rejects.toThrow(/kubectl said no/);
  });
});

/**
 * `agentRunsSince`'s tolerance for the cluster's coarser clock, checked without a
 * cluster by stubbing `kubectl` at the process boundary.
 *
 * Kubernetes stamps `creationTimestamp` to the SECOND and truncates; `since` is a
 * host-side `new Date()` in milliseconds. Compared directly, a run created at
 * x.800 is stamped x.000 and a `since` of x.200 hides it forever -- the trigger
 * looks like it launched nothing, however long you poll.
 *
 * This is pinned because the bug was total, silent, and read as a product defect:
 * `resilience.e2e.ts` failed on a different test each run with "timed out ...
 * waiting for an AgentRun to be created (204 attempts)" while that very turn had
 * succeeded and its reply was already posted to the issue.
 */
describe("agentRunsSince tolerates the cluster's second-granularity timestamps", () => {
  const RUN = "5fb2b54d-960c-4882-ae52-9d1921c82a32";

  /** Makes `kubectl get agentruns -o json` return one run stamped at `stamp`. */
  function stubKubectl(stamp: string): () => void {
    const original = process.env.PATH;
    const dir = mkdtempSync(join(tmpdir(), "e2e-kubectl-stub-"));
    const payload = JSON.stringify({
      items: [{ metadata: { name: RUN, creationTimestamp: stamp }, status: { phase: "Running" } }],
    });
    // Must answer BOTH calls the helper makes: the guard's `config
    // current-context` (or it fails closed and this tests nothing) and the
    // `get agentruns -o json` under test.
    writeFileSync(
      join(dir, "kubectl"),
      `#!/bin/sh\ncase "$*" in\n  *"config current-context"*) echo minikube ;;\n  *) cat <<'JSON'\n${payload}\nJSON\n  ;;\nesac\n`,
      { mode: 0o755 },
    );
    process.env.PATH = `${dir}:${original ?? ""}`;
    return () => {
      process.env.PATH = original;
    };
  }

  it("still finds a run whose stamp truncated to just BEFORE the trigger", async () => {
    // The exact losing case: triggered at .200 within the second, run created at
    // .800, stamped at .000 -> 800ms "before" the trigger.
    const restore = stubKubectl("2026-07-31T14:07:05Z");
    try {
      const since = new Date("2026-07-31T14:07:05.200Z");
      expect((await agentRunsSince(since)).map((r) => r.name)).toEqual([RUN]);
    } finally {
      restore();
    }
  });

  it("still finds a run when the node clock lags the host by a second", async () => {
    const restore = stubKubectl("2026-07-31T14:07:04Z");
    try {
      expect((await agentRunsSince(new Date("2026-07-31T14:07:05.900Z"))).map((r) => r.name)).toEqual([RUN]);
    } finally {
      restore();
    }
  });

  it("does NOT reach back far enough to claim a previous turn's run", async () => {
    // The opposite failure, and the worse one: a tolerance wide enough to pick up
    // the prior turn would make assertions pass against the wrong run. Triggers in
    // these specs are >=20s apart, so 10s must stay outside the window.
    const restore = stubKubectl("2026-07-31T14:06:55Z");
    try {
      expect(await agentRunsSince(new Date("2026-07-31T14:07:05.000Z"))).toEqual([]);
    } finally {
      restore();
    }
  });
});
