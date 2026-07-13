import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiDelegateSelector } from "./delegate-selector.js";
import type { AgentSearchResult } from "../agents/types.js";
import type { SkillSearchResult } from "../skills/types.js";

function skill(id: string): SkillSearchResult {
  return { skill: { id, name: id, description: `Skill ${id}`, markdown: "# instructions", toolIds: ["some-tool"] }, score: 0.5 };
}

function agent(id: string): AgentSearchResult {
  return {
    agent: {
      id,
      name: id,
      description: `Agent ${id}`,
      allowedRoles: ["writer"],
      agentRunTemplate: { namespace: "default", agentRef: id },
    },
    score: 0.5,
  };
}

function fakeClient(selectedType: "skill" | "agent" | null, selectedId: string | null): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({
          choices: [{ message: { content: JSON.stringify({ selected_type: selectedType, selected_id: selectedId }) } }],
        }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiDelegateSelector", () => {
  it("returns undefined immediately when there are no candidates at all", async () => {
    const client = fakeClient(null, null);
    const selector = new OpenAiDelegateSelector({ client });
    await expect(selector.select("do a thing", [], [])).resolves.toBeUndefined();
    expect(client.chat.completions.create).not.toHaveBeenCalled();
  });

  it("returns the matching skill when the model picks a skill", async () => {
    const client = fakeClient("skill", "s1");
    const selector = new OpenAiDelegateSelector({ client });
    const result = await selector.select("do a thing", [skill("s1"), skill("s2")], [agent("a1")]);
    expect(result).toEqual({ type: "skill", skill: skill("s1").skill });
  });

  it("returns the matching agent when the model picks an agent", async () => {
    const client = fakeClient("agent", "a1");
    const selector = new OpenAiDelegateSelector({ client });
    const result = await selector.select("do a thing", [skill("s1")], [agent("a1"), agent("a2")]);
    expect(result).toEqual({ type: "agent", agent: agent("a1").agent });
  });

  it("returns undefined when the model selects null", async () => {
    const client = fakeClient(null, null);
    const selector = new OpenAiDelegateSelector({ client });
    const result = await selector.select("do a thing", [skill("s1")], [agent("a1")]);
    expect(result).toBeUndefined();
  });

  it("returns undefined when the model selects an id outside the matching type's candidate list", async () => {
    const client = fakeClient("skill", "not-a-candidate");
    const selector = new OpenAiDelegateSelector({ client });
    const result = await selector.select("do a thing", [skill("s1")], [agent("a1")]);
    expect(result).toBeUndefined();
  });

  it("still calls the model when only agents (no skills) are candidates", async () => {
    const client = fakeClient("agent", "a1");
    const selector = new OpenAiDelegateSelector({ client });
    const result = await selector.select("do a thing", [], [agent("a1")]);
    expect(result).toEqual({ type: "agent", agent: agent("a1").agent });
  });
});
