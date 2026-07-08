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
});
