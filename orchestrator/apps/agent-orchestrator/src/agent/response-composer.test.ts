import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiResponseComposer } from "./response-composer.js";
import type { SkillDescriptor } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const skill: SkillDescriptor = {
  id: "recipe-refining-skill",
  name: "Recipe Refining",
  description: "Extract, publish, and refine recipes",
  markdown: "# instructions\nAfter recipe-scraper, invite the user to confirm publishing.",
  toolIds: ["recipe-scraper", "recipe-publisher"],
};

const scraperTool: ToolDescriptor = {
  id: "recipe-scraper",
  name: "recipe-scraper",
  description: "Scrapes a recipe from a URL",
  allowedRoles: ["reader"],
  jobTemplate: { image: "example.com/recipe-scraper:latest", namespace: "default", serviceAccountName: "sa" },
};

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

describe("OpenAiResponseComposer", () => {
  it("returns the prefix/suffix narration chosen by the model", async () => {
    const client = fakeClient({ prefix: null, suffix: "\n\n---\nConfirm to publish?" });
    const composer = new OpenAiResponseComposer({ client });

    const result = await composer.compose("extract it", skill, scraperTool, "# Pancakes");

    expect(result).toEqual({ prefix: null, suffix: "\n\n---\nConfirm to publish?" });
  });

  it("normalizes a fully-empty narration to nulls", async () => {
    const client = fakeClient({ prefix: null, suffix: null });
    const composer = new OpenAiResponseComposer({ client });

    const result = await composer.compose("publish it", skill, scraperTool, "# Pancakes\n\n<!-- mealie-slug: x -->");

    expect(result).toEqual({ prefix: null, suffix: null });
  });

  it("fails safe to no narration when the model response isn't valid JSON", async () => {
    const client = {
      chat: { completions: { create: vi.fn().mockResolvedValue({ choices: [{ message: { content: "not json" } }] }) } },
    } as unknown as OpenAI;
    const composer = new OpenAiResponseComposer({ client });

    const result = await composer.compose("do a thing", skill, scraperTool, "# Pancakes");

    expect(result).toEqual({ prefix: null, suffix: null });
  });

  it("injects the skill markdown into the system prompt and passes the tool output as untrusted data", async () => {
    const client = fakeClient({ prefix: null, suffix: null });
    const composer = new OpenAiResponseComposer({ client });

    await composer.compose("extract it", skill, scraperTool, "# Pancakes\n\n## Ingredients\n\n1. 2 eggs");

    const call = (client.chat.completions.create as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as {
      messages: { role: string; content: string }[];
    };
    const systemMessage = call.messages.find((m) => m.role === "system");
    const userMessage = call.messages.find((m) => m.role === "user");
    expect(systemMessage?.content).toContain(skill.markdown);
    // The tool output is handed over verbatim for the model to narrate around.
    expect(userMessage?.content).toContain("# Pancakes\n\n## Ingredients\n\n1. 2 eggs");
  });
});
