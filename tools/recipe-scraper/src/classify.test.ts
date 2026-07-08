import { describe, it, expect } from "vitest";
import { classify } from "./classify.js";
import type { SafeUrl } from "./security/url-guard.js";

function safe(raw: string): SafeUrl {
  return { url: new URL(raw), addresses: ["1.1.1.1"] };
}

describe("classify", () => {
  it("detects video hosts locally", async () => {
    expect(await classify(safe("https://www.youtube.com/watch?v=abc"))).toBe("video");
    expect(await classify(safe("https://youtu.be/abc"))).toBe("video");
    expect(await classify(safe("https://www.tiktok.com/@x/video/1"))).toBe("video");
    expect(await classify(safe("https://vm.tiktok.com/xyz"))).toBe("video");
    expect(await classify(safe("https://x.com/user/status/1"))).toBe("video");
  });

  it("detects images by extension locally", async () => {
    expect(await classify(safe("https://cdn.example.com/recipe.jpg"))).toBe("image");
    expect(await classify(safe("https://cdn.example.com/a/b/photo.PNG"))).toBe("image");
    expect(await classify(safe("https://cdn.example.com/card.webp"))).toBe("image");
  });
});
