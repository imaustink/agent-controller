import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiToolFitChecker } from "./tool-fit-checker.js";
import type { ToolDescriptor } from "../tool-descriptor.js";

const opencodeSweAgentTool: ToolDescriptor = {
  id: "opencode-swe-agent-tool",
  name: "opencode-swe-agent-tool",
  description: "Delegates a software-engineering task: create or clone a repository, implement a change, and open a pull request.",
  allowedRoles: ["writer"],
  agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
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

describe("OpenAiToolFitChecker", () => {
  it("returns true when the model judges the tool a genuine fit", async () => {
    const checker = new OpenAiToolFitChecker({ client: fakeClient(JSON.stringify({ fits: true })) });
    await expect(checker.fits("open a PR adding this feature", opencodeSweAgentTool)).resolves.toBe(true);
  });

  it("returns false when the model rejects a superficial keyword-overlap match", async () => {
    const checker = new OpenAiToolFitChecker({ client: fakeClient(JSON.stringify({ fits: false })) });
    await expect(checker.fits("help me create a recipe from scratch", opencodeSweAgentTool)).resolves.toBe(false);
  });

  it("returns false (safe default) on unparseable model output", async () => {
    const checker = new OpenAiToolFitChecker({ client: fakeClient("not json") });
    await expect(checker.fits("do something", opencodeSweAgentTool)).resolves.toBe(false);
  });

  it("passes the tool name/description and the request to the model", async () => {
    const client = fakeClient(JSON.stringify({ fits: true }));
    const checker = new OpenAiToolFitChecker({ client });
    await checker.fits("make a recipe", opencodeSweAgentTool);

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: { role: string; content: string }[];
    };
    const userMessage = call.messages.find((m) => m.role === "user")!;
    expect(userMessage.content).toContain(opencodeSweAgentTool.name);
    expect(userMessage.content).toContain(opencodeSweAgentTool.description);
    expect(userMessage.content).toContain("make a recipe");
  });
});
