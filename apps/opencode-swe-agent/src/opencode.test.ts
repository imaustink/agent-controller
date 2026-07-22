import { describe, expect, it } from "vitest";
import { parseOpencodeLine } from "./opencode.js";

describe("parseOpencodeLine", () => {
  it("surfaces a successful tool-result as narrative content", () => {
    const signal = parseOpencodeLine(
      JSON.stringify({ type: "tool-result", toolName: "read", result: "file contents here", success: true }),
    );
    expect(signal).toEqual({ progress: "read →\nfile contents here", progressKind: "narrative" });
  });

  it("still surfaces a failed tool-result as a toolFailure, not narrative", () => {
    const signal = parseOpencodeLine(
      JSON.stringify({ type: "tool-result", toolName: "bash", error: "command not found", isError: true }),
    );
    expect(signal).toEqual({ toolFailure: "command not found" });
  });

  it("drops a tool-result with no content", () => {
    expect(parseOpencodeLine(JSON.stringify({ type: "tool-result", success: true }))).toBeNull();
  });

  it("still narrates assistant text deltas", () => {
    const signal = parseOpencodeLine(JSON.stringify({ type: "text-delta", text: "Found the repo." }));
    expect(signal).toEqual({ progress: "Found the repo.", isDelta: true, progressKind: "narrative" });
  });
});
