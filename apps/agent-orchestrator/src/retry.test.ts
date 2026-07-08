import { describe, expect, it } from "vitest";
import { retryWithBackoff } from "./retry.js";

const noSleep = async (): Promise<void> => {};

describe("retryWithBackoff", () => {
  it("returns the result immediately when the first attempt succeeds", async () => {
    let calls = 0;
    const result = await retryWithBackoff(
      "op",
      async () => {
        calls++;
        return "ok";
      },
      { attempts: 3, initialDelayMs: 10, maxDelayMs: 100, sleep: noSleep, log: () => {} },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  it("retries until the operation succeeds", async () => {
    let calls = 0;
    const logs: string[] = [];
    const result = await retryWithBackoff(
      "qdrant",
      async () => {
        calls++;
        if (calls < 3) throw new Error("fetch failed");
        return 42;
      },
      { attempts: 5, initialDelayMs: 10, maxDelayMs: 100, sleep: noSleep, log: (m) => logs.push(m) },
    );
    expect(result).toBe(42);
    expect(calls).toBe(3);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("qdrant failed (attempt 1/5): fetch failed");
  });

  it("throws the last error after exhausting all attempts", async () => {
    let calls = 0;
    await expect(
      retryWithBackoff(
        "op",
        async () => {
          calls++;
          throw new Error(`boom ${calls}`);
        },
        { attempts: 3, initialDelayMs: 10, maxDelayMs: 100, sleep: noSleep, log: () => {} },
      ),
    ).rejects.toThrow("boom 3");
    expect(calls).toBe(3);
  });

  it("doubles the delay each retry, capped at maxDelayMs", async () => {
    const delays: number[] = [];
    let calls = 0;
    await retryWithBackoff(
      "op",
      async () => {
        calls++;
        if (calls < 5) throw new Error("nope");
        return null;
      },
      {
        attempts: 5,
        initialDelayMs: 100,
        maxDelayMs: 250,
        sleep: async (ms) => {
          delays.push(ms);
        },
        log: () => {},
      },
    );
    expect(delays).toEqual([100, 200, 250, 250]);
  });
});
