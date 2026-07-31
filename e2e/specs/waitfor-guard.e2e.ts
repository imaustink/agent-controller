import { describe, expect, it } from "vitest";
import { waitFor } from "../support/k8s.js";

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
