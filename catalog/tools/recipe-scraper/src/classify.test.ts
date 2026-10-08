import { describe, it, expect, vi, beforeEach } from "vitest";
import { classify } from "./classify.js";
import { guardedFetch } from "./util/download.js";
import type { SafeUrl } from "./security/url-guard.js";

vi.mock("./util/download.js", () => ({
  guardedFetch: vi.fn(),
}));

const mockGuardedFetch = vi.mocked(guardedFetch);

function safe(raw: string): SafeUrl {
  return { url: new URL(raw), addresses: ["1.1.1.1"] };
}

/** Makes guardedFetch resolve to a Response whose `url` is the given resolved URL. */
function resolvesTo(url: string): void {
  mockGuardedFetch.mockResolvedValue({ url } as Response);
}

describe("classify", () => {
  beforeEach(() => {
    mockGuardedFetch.mockReset();
  });

  it("detects video hosts locally", async () => {
    expect(await classify(safe("https://www.youtube.com/watch?v=abc"))).toBe("video");
    expect(await classify(safe("https://youtu.be/abc"))).toBe("video");
    expect(await classify(safe("https://www.tiktok.com/@x/video/1"))).toBe("video");
    expect(await classify(safe("https://x.com/user/status/1"))).toBe("video");
    // A TikTok `/video/` path is resolved locally, no network round trip.
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it("classifies TikTok photo (slideshow) posts as tiktok_photo", async () => {
    expect(await classify(safe("https://www.tiktok.com/@x/photo/123"))).toBe("tiktok_photo");
    expect(mockGuardedFetch).not.toHaveBeenCalled();
  });

  it("resolves TikTok short links to decide photo vs video", async () => {
    resolvesTo("https://www.tiktok.com/@user/photo/7605044141822577933");
    expect(await classify(safe("https://www.tiktok.com/t/ZP8px6UsV/"))).toBe("tiktok_photo");

    resolvesTo("https://www.tiktok.com/@user/video/7628980836104195341");
    expect(await classify(safe("https://vm.tiktok.com/xyz"))).toBe("video");
  });

  it("falls back to the video lane if short-link resolution fails", async () => {
    mockGuardedFetch.mockRejectedValue(new Error("network"));
    expect(await classify(safe("https://vm.tiktok.com/xyz"))).toBe("video");
  });

  it("detects images by extension locally", async () => {
    expect(await classify(safe("https://cdn.example.com/recipe.jpg"))).toBe("image");
    expect(await classify(safe("https://cdn.example.com/a/b/photo.PNG"))).toBe("image");
    expect(await classify(safe("https://cdn.example.com/card.webp"))).toBe("image");
  });
});
