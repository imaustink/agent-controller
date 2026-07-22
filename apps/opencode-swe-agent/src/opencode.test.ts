import { describe, expect, it } from "vitest";
import { parseOpencodeLine } from "./opencode.js";

// Fixtures below are lifted verbatim (trimmed) from a real production
// `opencode run --format json` event stream captured off a completed
// AgentRun pod's logs -- not guessed shapes. Confirmed: opencode emits a
// single "tool_use" event per call with the result nested under
// `part.state`, not a separate "tool-result" event.

describe("parseOpencodeLine", () => {
  it("surfaces a completed tool_use's output as narrative content", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "read",
        callID: "toolu_01MAhEFzsCeAQiQDuEjNM2YV",
        state: {
          status: "completed",
          input: { filePath: "apps/agent-orchestrator/src/openai/with-heartbeat.ts" },
          output: "<path>apps/agent-orchestrator/src/openai/with-heartbeat.ts</path>\n<content>...</content>",
        },
      },
    });
    expect(parseOpencodeLine(line)).toEqual({
      progress: "read →\n<path>apps/agent-orchestrator/src/openai/with-heartbeat.ts</path>\n<content>...</content>",
      progressKind: "narrative",
    });
  });

  it("surfaces a malformed ('invalid') tool call as a toolFailure, not narrative", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "invalid",
        callID: "toolu_01BCkeR5hGVHpTjT6NkqsRFT",
        state: {
          status: "completed",
          input: { tool: "read", error: "Invalid input for tool read: JSON parsing failed" },
          output: "The arguments provided to the tool are invalid: Invalid input for tool read: JSON parsing failed",
        },
      },
    });
    expect(parseOpencodeLine(line)).toEqual({
      toolFailure: "The arguments provided to the tool are invalid: Invalid input for tool read: JSON parsing failed",
    });
  });

  it("does not treat a non-zero bash exit code as a toolFailure (opencode itself never flags it as one)", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: {
        type: "tool",
        tool: "bash",
        callID: "toolu_x",
        state: {
          status: "completed",
          input: { command: "which redis-server" },
          output: "",
          metadata: { exit: 1 },
        },
      },
    });
    // Empty output falls back to the terse in-flight status line, same as a
    // call still running -- there's simply no content to narrate either way.
    expect(parseOpencodeLine(line)).toEqual({ progress: "running bash", progressKind: "status" });
  });

  it("emits a terse 'running <tool>' status while a tool call is still in flight", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "bash", callID: "toolu_x", state: { status: "running" } },
    });
    expect(parseOpencodeLine(line)).toEqual({ progress: "running bash", progressKind: "status" });
  });

  it("narrates the agent's own assistant text", () => {
    const line = JSON.stringify({
      type: "text",
      part: { type: "text", text: "Now let's check server.ts for how heartbeat is wired." },
    });
    expect(parseOpencodeLine(line)).toEqual({
      finalMessage: "Now let's check server.ts for how heartbeat is wired.",
      progress: "Now let's check server.ts for how heartbeat is wired.",
      progressKind: "narrative",
    });
  });

  it("ignores step_start/step_finish bookkeeping events", () => {
    expect(parseOpencodeLine(JSON.stringify({ type: "step_start", part: { type: "step-start" } }))).toBeNull();
    expect(
      parseOpencodeLine(JSON.stringify({ type: "step_finish", part: { type: "step-finish", reason: "tool-calls" } })),
    ).toBeNull();
  });

  it("falls back to a toolFailure for the plausible-but-unobserved standalone tool-result shape", () => {
    const signal = parseOpencodeLine(
      JSON.stringify({ type: "tool-result", toolName: "bash", error: "command not found", isError: true }),
    );
    expect(signal).toEqual({ toolFailure: "command not found" });
  });
});
