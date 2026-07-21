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
