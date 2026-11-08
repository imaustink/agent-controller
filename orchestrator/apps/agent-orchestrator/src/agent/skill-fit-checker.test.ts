import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiSkillFitChecker } from "./skill-fit-checker.js";
import type { SkillDescriptor } from "../skills/types.js";

const skill: SkillDescriptor = {
  id: "recipe-skill",
  name: "Recipe Extraction & Publishing",
  description: "Extract, adjust, and publish recipes",
  markdown: "# instructions",
  toolIds: ["recipe-scraper"],
};

function fakeClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiSkillFitChecker", () => {
  it("returns true when the model judges the turn to fit", async () => {
    const checker = new OpenAiSkillFitChecker({ client: fakeClient(JSON.stringify({ fits: true })) });
    await expect(checker.fits("yes, publish it", skill)).resolves.toBe(true);
  });

  it("returns false when the model judges the turn not to fit", async () => {
    const checker = new OpenAiSkillFitChecker({ client: fakeClient(JSON.stringify({ fits: false })) });
    await expect(checker.fits("write me a poem", skill)).resolves.toBe(false);
  });

  it("returns false (safe fallback to re-selection) on unparseable model output", async () => {
    const checker = new OpenAiSkillFitChecker({ client: fakeClient("not json") });
    await expect(checker.fits("yes", skill)).resolves.toBe(false);
  });

  it("passes the skill name/description and the message to the model", async () => {
    const client = fakeClient(JSON.stringify({ fits: true }));
    const checker = new OpenAiSkillFitChecker({ client });
    await checker.fits("make it spicier", skill);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: { role: string; content: string }[];
    };
    const userMessage = call.messages.find((m) => m.role === "user")!;
    expect(userMessage.content).toContain(skill.name);
    expect(userMessage.content).toContain(skill.description);
    expect(userMessage.content).toContain("make it spicier");
  });
});
