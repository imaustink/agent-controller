import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiActionPlanner } from "./action-planner.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const skill: SkillDescriptor = {
  id: "recipe-publisher-skill",
  name: "Recipe Extraction & Publishing",
  description: "Extract, adjust, and publish recipes",
  markdown: "# instructions",
  toolIds: ["recipe-scraper", "recipe-publisher"],
};

const tools: ToolDescriptor[] = [
  {
    id: "recipe-scraper",
    name: "recipe-scraper",
    description: "Scrapes a recipe from a URL",
    allowedRoles: ["reader"],
    jobTemplate: { image: "example.com/recipe-scraper:latest", namespace: "default", serviceAccountName: "sa" },
  },
];

function fakeClient(response: unknown): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify(response) } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiActionPlanner", () => {
  it("returns a call_tool action with the tool id and args from the model", async () => {
    const client = fakeClient({
      action: "call_tool",
      response: null,
      tool_id: "recipe-scraper",
      tool_args: "https://example.com/recipe",
    });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("extract https://example.com/recipe", skill, tools);

    expect(result).toEqual({ action: "call_tool", toolId: "recipe-scraper", toolArgs: "https://example.com/recipe" });
  });

  it("returns a call_tool action with a toolInstanceKey when the model sets one (ADR 0017)", async () => {
    const client = fakeClient({
      action: "call_tool",
      response: null,
      tool_id: "recipe-scraper",
      tool_args: "some full recipe markdown",
      tool_instance_key: "https://example.com/recipe",
    });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("publish this", skill, tools);

    expect(result).toEqual({
      action: "call_tool",
      toolId: "recipe-scraper",
      toolArgs: "some full recipe markdown",
      toolInstanceKey: "https://example.com/recipe",
    });
  });

  it("omits toolInstanceKey when the model leaves it null", async () => {
    const client = fakeClient({
      action: "call_tool",
      response: null,
      tool_id: "recipe-scraper",
      tool_args: "https://example.com/recipe",
      tool_instance_key: null,
    });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("extract https://example.com/recipe", skill, tools);

    expect(result).toEqual({ action: "call_tool", toolId: "recipe-scraper", toolArgs: "https://example.com/recipe" });
    expect(result).not.toHaveProperty("toolInstanceKey");
  });

  it("returns a respond action with the model's direct reply", async () => {
    const client = fakeClient({
      action: "respond",
      response: '{"recipe":{"tags":["vegetarian"]}}',
      tool_id: null,
      tool_args: null,
    });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("make it vegetarian", skill, tools);

    expect(result).toEqual({ action: "respond", response: '{"recipe":{"tags":["vegetarian"]}}' });
  });

  it("falls back to a respond action when the model response isn't valid JSON", async () => {
    const client = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "not json" } }] }) } },
    } as unknown as OpenAI;
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("do a thing", skill, tools);

    expect(result.action).toBe("respond");
  });

  it("injects the skill markdown into the system prompt", async () => {
    const client = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    await planner.plan("do a thing", skill, tools);

    const call = (client.chat.completions.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const systemMessage = call.messages.find((m) => m.role === "system");
    expect(systemMessage?.content).toContain(skill.markdown);
  });

  it("injects prior tool calls as <prior_tool_calls> context, enabling a second tool call (docs/adr/0008 update)", async () => {
    const client = fakeClient({
      action: "call_tool",
      response: null,
      tool_id: "recipe-scraper",
      tool_args: "https://example.com/other-recipe",
    });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("do a thing", skill, tools, [
      { toolId: "recipe-scraper", toolArgs: "https://example.com/recipe", result: "some prior result" },
    ]);

    expect(result).toEqual({
      action: "call_tool",
      toolId: "recipe-scraper",
      toolArgs: "https://example.com/other-recipe",
    });
    const call = (client.chat.completions.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const userMessage = call.messages.find((m) => m.role === "user");
    expect(userMessage?.content).toContain("<prior_tool_calls>");
    expect(userMessage?.content).toContain("https://example.com/recipe");
    expect(userMessage?.content).toContain("some prior result");
  });

  it("omits <prior_tool_calls> when no history is given", async () => {
    const client = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    await planner.plan("do a thing", skill, tools);

    const call = (client.chat.completions.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const userMessage = call.messages.find((m) => m.role === "user");
    expect(userMessage?.content).not.toContain("<prior_tool_calls>");
  });

  it("returns a finish action when history is non-empty and the model chooses to stop", async () => {
    const client = fakeClient({ action: "finish", response: null, tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("do a thing", skill, tools, [
      { toolId: "recipe-scraper", toolArgs: "https://example.com/recipe", result: "some prior result" },
    ]);

    expect(result).toEqual({ action: "finish" });
  });

  it("falls back to respond when the model says finish with no prior tool calls (finish is meaningless on the first decision)", async () => {
    const client = fakeClient({ action: "finish", response: "fallback text", tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    const result = await planner.plan("do a thing", skill, tools);

    expect(result).toEqual({ action: "respond", response: "fallback text" });
  });
});

describe("OpenAiActionPlanner — consumer-supplied tools (docs/adr/0035)", () => {
  const callerTool: ToolDescriptor = {
    id: "caller:get_weather",
    name: "get_weather",
    description: "Look up the weather",
    allowedRoles: [],
    callerTool: {
      name: "get_weather",
      description: "Look up the weather",
      parametersJson: '{"properties":{"city":{"type":"string"}},"type":"object"}',
      hash: "b".repeat(64),
    },
  };

  /** The prompt the planner actually sent, for assertions below. */
  function sentPrompt(client: OpenAI): { system: string; user: string } {
    const call = (client.chat.completions.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    return {
      system: call.messages.find((m) => m.role === "system")?.content ?? "",
      user: call.messages.find((m) => m.role === "user")?.content ?? "",
    };
  }

  it("renders caller tools in their own block, out of <available_tools>", async () => {
    const client = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    await planner.plan("weather?", skill, [...tools, callerTool]);

    const { user } = sentPrompt(client);
    // Catalog tool stays in the plain list; the caller tool does not.
    const availableBlock = user.slice(user.indexOf("<available_tools>"), user.indexOf("</available_tools>"));
    expect(availableBlock).toContain("recipe-scraper");
    expect(availableBlock).not.toContain("caller:get_weather");
    expect(user).toContain("<caller_supplied_tools>");
    expect(user).toContain("caller:get_weather");
  });

  it("frames caller-supplied text as untrusted and includes the JSON schema", async () => {
    // Untrusted because it's per-request caller data -- a level below a Tool CR
    // description and two below the skill markdown. The schema has to be there
    // for the planner to produce conforming arguments.
    const client = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    await planner.plan("weather?", skill, [callerTool]);

    const { user } = sentPrompt(client);
    expect(user).toContain("UNTRUSTED");
    expect(user).toContain('json_schema: {"properties":{"city":{"type":"string"}},"type":"object"}');
    expect(user).toContain("JSON OBJECT literal");
  });

  it("omits the block entirely when no caller tools were supplied", async () => {
    const client = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    const planner = new OpenAiActionPlanner({ client });

    await planner.plan("do a thing", skill, tools);

    expect(sentPrompt(client).user).not.toContain("<caller_supplied_tools>");
  });

  it("adds a tool-required directive only when the caller asked for one AND has tools on offer", async () => {
    const withTools = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    await new OpenAiActionPlanner({ client: withTools }).plan("weather?", skill, [callerTool], [], {
      callerToolRequired: true,
    });
    expect(sentPrompt(withTools).system).toContain("requested that a tool be called");

    // No caller tools -> the directive would be meaningless.
    const withoutTools = fakeClient({ action: "respond", response: "ok", tool_id: null, tool_args: null });
    await new OpenAiActionPlanner({ client: withoutTools }).plan("do a thing", skill, tools, [], {
      callerToolRequired: true,
    });
    expect(sentPrompt(withoutTools).system).not.toContain("requested that a tool be called");
  });
});
