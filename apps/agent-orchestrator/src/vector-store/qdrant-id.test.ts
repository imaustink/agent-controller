import { describe, expect, it } from "vitest";
import { toQdrantPointId } from "./qdrant-id.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("toQdrantPointId", () => {
  it("produces a valid v5-formatted UUID (which Qdrant accepts as a native point id)", () => {
    expect(toQdrantPointId("recipe-scraper")).toMatch(UUID_RE);
  });

  it("is deterministic for the same input", () => {
    expect(toQdrantPointId("recipe-scraper")).toBe(toQdrantPointId("recipe-scraper"));
  });

  it("differs across distinct inputs", () => {
    expect(toQdrantPointId("recipe-scraper")).not.toBe(toQdrantPointId("recipe-publisher"));
  });
});
