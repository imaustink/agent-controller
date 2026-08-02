import { describe, expect, it } from "vitest";
import { FilterSchema, QuerySchema } from "./schema.js";

describe("FilterSchema", () => {
  it("accepts an array value for op \"in\"", () => {
    expect(FilterSchema.safeParse({ key: "k", op: "in", value: ["a", "b"] }).success).toBe(true);
  });

  it("accepts a scalar value for the equality/contains ops", () => {
    for (const op of ["=", "!=", "contains"] as const) {
      expect(FilterSchema.safeParse({ key: "k", op, value: "a" }).success).toBe(true);
    }
  });

  it("rejects a scalar value for op \"in\"", () => {
    const res = FilterSchema.safeParse({ key: "k", op: "in", value: "a" });
    expect(res.success).toBe(false);
  });

  it("rejects an array value for the scalar ops", () => {
    for (const op of ["=", "!=", "contains"] as const) {
      expect(FilterSchema.safeParse({ key: "k", op, value: ["a", "b"] }).success).toBe(false);
    }
  });
});

describe("QuerySchema filter op/value coupling", () => {
  it("rejects a query whose filter mismatches op and value shape", () => {
    const res = QuerySchema.safeParse({
      signal: "logs",
      start: "-1h",
      end: "now",
      filters: [{ key: "severity_text", op: "in", value: "ERROR" }],
    });
    expect(res.success).toBe(false);
  });
});
