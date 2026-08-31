import { describe, it, expect } from "vitest";
import { renderResult } from "./render.js";

const url = "https://s3.example.com/images/job-1.png?sig=abc";

describe("renderResult", () => {
  it("labels a generation and embeds the URL as an image", () => {
    const out = renderResult({ prompt: "a bowl of ramen" }, url);
    expect(out).toContain("**Generated image**");
    expect(out).toContain(`![a bowl of ramen](${url})`);
    expect(out).toContain("Prompt: a bowl of ramen");
  });

  it("labels an edit when a source image_url was supplied", () => {
    const out = renderResult({ prompt: "add an egg", image_url: "https://example.com/prev.png" }, url);
    expect(out).toContain("**Edited image**");
    expect(out).toContain(url);
  });
});
