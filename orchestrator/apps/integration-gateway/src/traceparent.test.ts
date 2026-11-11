import { describe, expect, it } from "vitest";
import { nextTraceparent, traceIdOf } from "./traceparent.js";

describe("traceparent (docs/adr/0050 §4)", () => {
  const inbound = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

  it("continues a valid inbound trace with a fresh span id", () => {
    const next = nextTraceparent(inbound);
    expect(traceIdOf(next)).toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    expect(next).not.toBe(inbound);
    expect(next).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it.each([undefined, "", "garbage", "00-" + "0".repeat(32) + "-00f067aa0ba902b7-01", "01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"])(
    "starts a new trace for %j",
    (bad) => {
      const next = nextTraceparent(bad);
      expect(traceIdOf(next)).toBeDefined();
      expect(traceIdOf(next)).not.toBe("4bf92f3577b34da6a3ce929d0e0e4736");
    },
  );
});
