import { describe, it, expect } from "vitest";
import { parseInput } from "./schema.js";

describe("parseInput", () => {
  it("treats a bare string as the prompt (generate branch)", () => {
    const input = parseInput("a bowl of ramen");
    expect(input.prompt).toBe("a bowl of ramen");
    expect(input.image_url).toBeUndefined();
  });

  it("parses a JSON object", () => {
    const input = parseInput('{"prompt":"add an egg","image_url":"https://example.com/prev.png"}');
    expect(input.prompt).toBe("add an egg");
    expect(input.image_url).toBe("https://example.com/prev.png");
  });

  it("carries optional size/quality/background through", () => {
    const input = parseInput('{"prompt":"x","size":"1024x1536","quality":"high","background":"transparent"}');
    expect(input.size).toBe("1024x1536");
    expect(input.quality).toBe("high");
    expect(input.background).toBe("transparent");
  });

  it("rejects an empty prompt", () => {
    expect(() => parseInput('{"prompt":""}')).toThrow();
    expect(() => parseInput("   ")).toThrow();
  });

  it("rejects a non-URL image_url", () => {
    expect(() => parseInput('{"prompt":"x","image_url":"not-a-url"}')).toThrow();
  });

  it("reports a helpful error for malformed JSON", () => {
    expect(() => parseInput('{"prompt": ')).toThrow(/failed to parse/);
  });
});
