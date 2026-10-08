import { describe, expect, it } from "vitest";
import {
  buildAgentRequest,
  chatCompletionToolCallResponse,
  isInternalUiTaskRequest,
  toolCallDeltaChunk,
} from "./chat-completions.js";

describe("buildAgentRequest", () => {
  it("returns the latest user message with no history to fold", () => {
    expect(buildAgentRequest([{ role: "user", content: "hello" }])).toEqual({
      request: "hello",
      priorToolCalls: [],
    });
  });

  it("returns undefined without a usable user message", () => {
    expect(buildAgentRequest(undefined)).toBeUndefined();
    expect(buildAgentRequest([])).toBeUndefined();
    expect(buildAgentRequest([{ role: "assistant", content: "hi" }])).toBeUndefined();
    expect(buildAgentRequest([{ role: "user", content: "   " }])).toBeUndefined();
  });

  it("folds prior turns into a conversation_history block", () => {
    const built = buildAgentRequest([
      { role: "user", content: "first" },
      { role: "assistant", content: "answer" },
      { role: "user", content: "second" },
    ]);
    expect(built!.request).toContain("<conversation_history>");
    expect(built!.request).toContain("first");
    expect(built!.request).toContain("answer");
    expect(built!.request.endsWith("second")).toBe(true);
  });

  describe("caller-executed tool results (docs/adr/0035 §1)", () => {
    /** The exact shape an OpenAI client resends after running a tool for us. */
    const resumed = [
      { role: "user", content: "what's the weather in Chicago?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Chicago"}' } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "58F and raining" },
    ];

    it("pairs a tool result back to the call that requested it", () => {
      const built = buildAgentRequest(resumed);
      expect(built!.priorToolCalls).toEqual([
        { id: "call_1", name: "get_weather", arguments: '{"city":"Chicago"}', result: "58F and raining" },
      ]);
    });

    it("keeps the tool exchange out of the prose request", () => {
      // It must reach the planner as a structured tool RESULT, not as
      // conversation text -- and the user's own message must stay the request.
      const built = buildAgentRequest(resumed);
      expect(built!.request).toBe("what's the weather in Chicago?");
      expect(built!.request).not.toContain("58F");
    });

    it("collects multiple parallel calls", () => {
      const built = buildAgentRequest([
        { role: "user", content: "compare Chicago and Denver" },
        {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "a", type: "function", function: { name: "get_weather", arguments: '{"city":"Chicago"}' } },
            { id: "b", type: "function", function: { name: "get_weather", arguments: '{"city":"Denver"}' } },
          ],
        },
        { role: "tool", tool_call_id: "a", content: "58F" },
        { role: "tool", tool_call_id: "b", content: "71F" },
      ]);
      expect(built!.priorToolCalls.map((c) => c.result)).toEqual(["58F", "71F"]);
    });

    it("ignores tool exchanges from an ALREADY-COMPLETED earlier turn", () => {
      // Those belong to a finished exchange, already represented by the
      // assistant prose in the folded history. Replaying them would make the
      // planner think it had just called those tools this turn.
      const built = buildAgentRequest([
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "old", type: "function", function: { name: "get_weather", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "old", content: "58F" },
        { role: "assistant", content: "It's 58F and raining." },
        { role: "user", content: "thanks, and tomorrow?" },
      ]);
      expect(built!.priorToolCalls).toEqual([]);
      expect(built!.request).toContain("It's 58F and raining.");
    });

    it("skips a tool result with no matching call", () => {
      // Without the paired call there is no tool name to attribute it to.
      const built = buildAgentRequest([
        { role: "user", content: "weather?" },
        { role: "tool", tool_call_id: "orphan", content: "58F" },
      ]);
      expect(built!.priorToolCalls).toEqual([]);
    });

    it("stringifies a non-string tool result", () => {
      const built = buildAgentRequest([
        { role: "user", content: "weather?" },
        { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "c", content: { tempF: 58 } },
      ]);
      expect(built!.priorToolCalls[0]!.result).toBe('{"tempF":58}');
    });

    it("is empty for an ordinary turn with no tool messages at all", () => {
      expect(buildAgentRequest([{ role: "user", content: "hi" }])!.priorToolCalls).toEqual([]);
    });
  });
});

describe("isInternalUiTaskRequest", () => {
  it("still recognizes Open WebUI housekeeping prompts", () => {
    // Load-bearing for docs/adr/0035 §5: these must never emit tool_calls, so
    // they're short-circuited before caller tools are even parsed.
    expect(isInternalUiTaskRequest("### Task:\nGenerate a title")).toBe(true);
    expect(isInternalUiTaskRequest("what's the weather?")).toBe(false);
  });
});

describe("tool_calls response shapes", () => {
  const calls = [{ id: "call_1", name: "get_weather", arguments: '{"city":"Chicago"}' }];

  it("renders a blocking response with content: null and finish_reason: tool_calls", () => {
    // A client that saw "stop" here would render an empty assistant message and
    // never execute anything.
    const body = chatCompletionToolCallResponse("id-1", "agent-orchestrator", calls) as {
      choices: { message: { content: unknown; tool_calls: unknown[] }; finish_reason: string }[];
    };
    expect(body.choices[0]!.finish_reason).toBe("tool_calls");
    expect(body.choices[0]!.message.content).toBeNull();
    expect(body.choices[0]!.message.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Chicago"}' } },
    ]);
  });

  it("renders a streaming delta with a per-call index", () => {
    // `index` is how a streaming client assembles multiple calls.
    const chunk = toolCallDeltaChunk("id-1", "agent-orchestrator", [...calls, { id: "call_2", name: "f", arguments: "{}" }]) as {
      choices: { delta: { tool_calls: { index: number; id: string }[] }; finish_reason: null }[];
    };
    expect(chunk.choices[0]!.delta.tool_calls.map((c) => [c.index, c.id])).toEqual([
      [0, "call_1"],
      [1, "call_2"],
    ]);
    expect(chunk.choices[0]!.finish_reason).toBeNull();
  });
});
