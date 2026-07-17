import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiBestEffortResponder } from "./best-effort-responder.js";

function fakeClient(content: string | null): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue({ choices: [{ message: { content } }] }),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiBestEffortResponder", () => {
  it("returns the model's answer", async () => {
    const responder = new OpenAiBestEffortResponder({ client: fakeClient("Here's a peach cocktail syrup recipe...") });
    await expect(responder.respond("help me create a recipe for peach cocktail syrup")).resolves.toBe(
      "Here's a peach cocktail syrup recipe...",
    );
  });

  it("falls back to a generic message when the model returns no content", async () => {
    const responder = new OpenAiBestEffortResponder({ client: fakeClient(null) });
    await expect(responder.respond("do something")).resolves.toMatch(/not able to help/i);
  });

  it("passes the request as the user message, with no tools available", async () => {
    const client = fakeClient("answer");
    const responder = new OpenAiBestEffortResponder({ client });
    await responder.respond("write me a haiku");

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      messages: { role: string; content: string }[];
    };
    expect(call.messages.find((m) => m.role === "user")?.content).toBe("write me a haiku");
    expect(call).not.toHaveProperty("tools");
  });
});
