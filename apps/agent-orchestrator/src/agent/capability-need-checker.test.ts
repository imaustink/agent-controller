import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiCapabilityNeedChecker } from "./capability-need-checker.js";

function fakeClient(content: string): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiCapabilityNeedChecker", () => {
  it("returns true when the model judges the request needs a capability", async () => {
    const checker = new OpenAiCapabilityNeedChecker({ client: fakeClient(JSON.stringify({ needsCapability: true })) });
    await expect(checker.needsCapability("publish this recipe to Mealie")).resolves.toBe(true);
  });

  it("returns false when the model judges the request purely conversational", async () => {
    const checker = new OpenAiCapabilityNeedChecker({ client: fakeClient(JSON.stringify({ needsCapability: false })) });
    await expect(checker.needsCapability("what's a good substitute for buttermilk?")).resolves.toBe(false);
  });

  it("returns true (safe default: fail open to existing search behavior) on unparseable model output", async () => {
    const checker = new OpenAiCapabilityNeedChecker({ client: fakeClient("not json") });
    await expect(checker.needsCapability("do something")).resolves.toBe(true);
  });

  it("passes the request to the model", async () => {
    const client = fakeClient(JSON.stringify({ needsCapability: false }));
    const checker = new OpenAiCapabilityNeedChecker({ client });
    await checker.needsCapability("tell me a joke");

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: { role: string; content: string }[];
    };
    const userMessage = call.messages.find((m) => m.role === "user")!;
    expect(userMessage.content).toContain("tell me a joke");
  });
});
