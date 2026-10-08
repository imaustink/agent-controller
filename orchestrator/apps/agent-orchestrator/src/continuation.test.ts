import { describe, expect, it } from "vitest";
import { resolveContinuationKey } from "./continuation.js";

describe("resolveContinuationKey", () => {
  it("scopes to an explicit instance key when the planner names one", () => {
    // The one case the model genuinely selects among instances (e.g. switching
    // to a different recipe): the explicit key always wins.
    expect(resolveContinuationKey("recipe-publisher", "https://x/pasta", {})).toBe(
      "recipe-publisher::https://x/pasta",
    );
  });

  it("recovers the active instance from server state when the planner names none", () => {
    // The core of the fix: a refine turn no longer has to re-extract the source
    // URL — the single existing continuation entry IS the publish target.
    const existing = { "recipe-publisher::https://x/pasta": "slug-pasta" };
    expect(resolveContinuationKey("recipe-publisher", undefined, existing)).toBe(
      "recipe-publisher::https://x/pasta",
    );
  });

  it("recovers a bare-keyed active instance too", () => {
    expect(resolveContinuationKey("recipe-publisher", undefined, { "recipe-publisher": "slug" })).toBe(
      "recipe-publisher",
    );
  });

  it("ignores other tools' entries when recovering the active instance", () => {
    const existing = {
      "image-gen::abc": "img-tok",
      "recipe-publisher::https://x/pasta": "slug-pasta",
    };
    expect(resolveContinuationKey("recipe-publisher", undefined, existing)).toBe(
      "recipe-publisher::https://x/pasta",
    );
  });

  it("falls back to the bare tool id on the first call (no state yet)", () => {
    expect(resolveContinuationKey("recipe-publisher", undefined, {})).toBe("recipe-publisher");
    expect(resolveContinuationKey("recipe-publisher", undefined, undefined)).toBe("recipe-publisher");
  });

  it("falls back rather than guessing when genuinely multi-instance", () => {
    // Two live instances and no key named: picking one could write one recipe's
    // edit onto another, so stay on the bare id instead.
    const existing = {
      "recipe-publisher::https://x/pasta": "slug-pasta",
      "recipe-publisher::https://x/soup": "slug-soup",
    };
    expect(resolveContinuationKey("recipe-publisher", undefined, existing)).toBe("recipe-publisher");
  });
});
