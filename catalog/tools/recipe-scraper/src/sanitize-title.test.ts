import { describe, it, expect } from "vitest";
import { sanitizeTitle } from "./sanitize-title.js";

describe("sanitizeTitle", () => {
  it("returns null unchanged", () => {
    expect(sanitizeTitle(null)).toBe(null);
  });

  it("strips leading emoji", () => {
    expect(sanitizeTitle("🌿 Chicken Pesto")).toBe("Chicken Pesto");
  });

  it("strips multiple emoji scattered through the title", () => {
    expect(sanitizeTitle("🍳 Easy Eggs 🥚 Breakfast")).toBe("Easy Eggs Breakfast");
  });

  it("does not strip regular ASCII or alphanumeric characters", () => {
    expect(sanitizeTitle("5-Minute Chicken & Pesto")).toBe("5-Minute Chicken & Pesto");
  });

  it("drops pipe-separated subtitle/site-name suffix", () => {
    expect(sanitizeTitle("Chicken Pesto | A ridiculously easy one-pan dinner")).toBe("Chicken Pesto");
  });

  it("drops pipe suffix even with emoji before the pipe", () => {
    expect(sanitizeTitle("🌿 5-Minute Dump & Bake Chicken Pesto | A ridiculously easy one-pan dinn")).toBe(
      "5-Minute Dump & Bake Chicken Pesto",
    );
  });

  it("collapses whitespace left behind after emoji removal", () => {
    expect(sanitizeTitle("🌿  Chicken   Pesto")).toBe("Chicken Pesto");
  });

  it("returns null when title becomes empty after cleaning", () => {
    expect(sanitizeTitle("🌿🍳")).toBe(null);
    expect(sanitizeTitle("   ")).toBe(null);
  });

  it("leaves plain titles unchanged", () => {
    expect(sanitizeTitle("Birria Tacos")).toBe("Birria Tacos");
  });
});
