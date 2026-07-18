import { describe, expect, it, vi } from "vitest";
import type OpenAI from "openai";
import { OpenAiBestEffortResponder } from "./best-effort-responder.js";

function fakeStream(deltas: (string | null)[]): AsyncIterable<{ choices: { delta: { content: string | null } }[] }> {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const delta of deltas) {
        yield { choices: [{ delta: { content: delta } }] };
      }
    },
  };
}

function fakeClient(deltas: (string | null)[]): OpenAI {
  return {
    chat: {
      completions: {
        create: vi.fn().mockResolvedValue(fakeStream(deltas)),
      },
    },
  } as unknown as OpenAI;
}

describe("OpenAiBestEffortResponder", () => {
  it("returns the model's answer, assembled from streamed deltas", async () => {
    const responder = new OpenAiBestEffortResponder({
      client: fakeClient(["Here's a peach ", "cocktail syrup ", "recipe..."]),
    });
    await expect(responder.respond("help me create a recipe for peach cocktail syrup")).resolves.toBe(
      "Here's a peach cocktail syrup recipe...",
    );
  });

  it("invokes onToken with each delta as it streams", async () => {
    const responder = new OpenAiBestEffortResponder({ client: fakeClient(["foo", "bar"]) });
    const onToken = vi.fn();
    await responder.respond("do something", onToken);
    expect(onToken.mock.calls).toEqual([["foo"], ["bar"]]);
  });

  it("falls back to a generic message when the model returns no content", async () => {
    const responder = new OpenAiBestEffortResponder({ client: fakeClient([null]) });
    await expect(responder.respond("do something")).resolves.toMatch(/not able to help/i);
  });

  it("requests streaming and passes the request as the user message, with no tools available", async () => {
    const client = fakeClient(["answer"]);
    const responder = new OpenAiBestEffortResponder({ client });
    await responder.respond("write me a haiku");

    const call = (client.chat.completions.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
      stream: boolean;
      messages: { role: string; content: string }[];
    };
    expect(call.stream).toBe(true);
    expect(call.messages.find((m) => m.role === "user")?.content).toBe("write me a haiku");
    expect(call).not.toHaveProperty("tools");
  });
});
