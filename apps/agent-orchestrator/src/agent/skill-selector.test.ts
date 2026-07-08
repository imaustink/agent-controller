import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiSkillSelector } from "./skill-selector.js";
import type { SkillDescriptor, SkillSearchResult } from "../skills/types.js";

function skill(id: string): SkillDescriptor {
  return {
    id,
    name: id,
    description: `Skill ${id}`,
    markdown: "# instructions",
    toolIds: ["some-tool"],
  };
}

function candidates(...ids: string[]): SkillSearchResult[] {
  return ids.map((id) => ({ skill: skill(id), score: 0.5 }));
}

function fakeClient(selectedId: string | null): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ selected_skill_id: selectedId }) } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiSkillSelector", () => {
  it("returns undefined immediately when there are no candidates", async () => {
    const client = fakeClient(null);
    const selector = new OpenAiSkillSelector({ client });
    await expect(selector.select("do a thing", [])).resolves.toBeUndefined();
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("returns the skill matching the selected id", async () => {
    const client = fakeClient("b");
    const selector = new OpenAiSkillSelector({ client });
    const result = await selector.select("do a thing", candidates("a", "b"));
    expect(result?.id).toBe("b");
  });

  it("returns undefined when the model selects null", async () => {
    const client = fakeClient(null);
    const selector = new OpenAiSkillSelector({ client });
    const result = await selector.select("do a thing", candidates("a", "b"));
    expect(result).toBeUndefined();
  });

  it("returns undefined when the model selects an id outside the candidate list", async () => {
    const client = fakeClient("not-a-candidate");
    const selector = new OpenAiSkillSelector({ client });
    const result = await selector.select("do a thing", candidates("a", "b"));
    expect(result).toBeUndefined();
  });
});
