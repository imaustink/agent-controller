import { describe, expect, it } from "vitest";
import {
  MAX_CALLER_TOOLS,
  MAX_DESCRIPTION_LENGTH,
  MAX_SCHEMA_LENGTH,
  makeCallerTool,
  parseCallerTools,
} from "./parse.js";

/** A minimal valid `tools[]` entry. */
function tool(name: string, description = "does a thing", parameters: unknown = { type: "object", properties: {} }) {
  return { type: "function", function: { name, description, parameters } };
}

describe("parseCallerTools", () => {
  it("returns an empty, permissive result when the caller sent no tools", () => {
    // The overwhelmingly common case -- must be indistinguishable from
    // pre-docs/adr/0035 behaviour downstream.
    expect(parseCallerTools(undefined)).toEqual({ tools: [], choice: { kind: "auto" } });
    expect(parseCallerTools(null)).toEqual({ tools: [], choice: { kind: "auto" } });
  });

  it("normalizes a valid tool array", () => {
    const parsed = parseCallerTools([tool("get_weather", "Look up the weather", { type: "object", properties: { city: { type: "string" } } })]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0]!.name).toBe("get_weather");
    expect(parsed.tools[0]!.description).toBe("Look up the weather");
    expect(parsed.tools[0]!.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats an omitted `type` as a function, since some clients omit it", () => {
    const parsed = parseCallerTools([{ function: { name: "ping", description: "" } }]);
    expect("error" in parsed).toBe(false);
  });

  it("hashes identically for schemas that differ only in key order", () => {
    // This is what makes the store an embedding CACHE (docs/adr/0035 §2): a
    // client serializing its schema non-deterministically must still hit it.
    const a = makeCallerTool("f", "d", { type: "object", properties: { b: { type: "string" }, a: { type: "number" } } });
    const b = makeCallerTool("f", "d", { properties: { a: { type: "number" }, b: { type: "string" } }, type: "object" });
    expect(a.hash).toBe(b.hash);
  });

  it("hashes differently when the description or schema changes, not just the name", () => {
    // An EDITED tool that kept its name is a different definition and must not
    // resolve to the stale embedding of the old one.
    const base = makeCallerTool("f", "original", { type: "object" });
    expect(makeCallerTool("f", "rewritten", { type: "object" }).hash).not.toBe(base.hash);
    expect(makeCallerTool("f", "original", { type: "object", required: ["x"] }).hash).not.toBe(base.hash);
  });

  it("rejects rather than silently dropping a malformed tool", () => {
    // Silently ignoring a caller's tools is the behaviour docs/adr/0035 exists
    // to fix -- the client can't tell "not chosen" from "never seen".
    expect(parseCallerTools("nope")).toEqual({ error: "tools must be an array" });
    expect(parseCallerTools([{ type: "retrieval" }])).toEqual({ error: 'tools[0].type must be "function"' });
    expect(parseCallerTools([{ type: "function" }])).toEqual({ error: "tools[0].function must be an object" });
    expect(parseCallerTools([tool("")])).toEqual({
      error: "tools[0].function.name must be a non-empty string",
    });
  });

  it("rejects a name outside OpenAI's allowed character set", () => {
    const parsed = parseCallerTools([tool("get weather!")]);
    expect("error" in parsed && parsed.error).toContain("must match [a-zA-Z0-9_-]");
  });

  it("rejects duplicate function names", () => {
    // Two tools with one name makes the round trip ambiguous: the client matches
    // our `function.name` back to one of its own functions.
    expect(parseCallerTools([tool("f"), tool("f")])).toEqual({ error: 'tools contains duplicate function name "f"' });
  });

  it("caps tool count, description length, and serialized schema size", () => {
    const many = Array.from({ length: MAX_CALLER_TOOLS + 1 }, (_, i) => tool(`f${i}`));
    expect("error" in parseCallerTools(many)).toBe(true);

    const longDescription = parseCallerTools([tool("f", "x".repeat(MAX_DESCRIPTION_LENGTH + 1))]);
    expect("error" in longDescription && longDescription.error).toContain("description exceeds");

    const bigSchema = parseCallerTools([tool("f", "d", { type: "object", description: "y".repeat(MAX_SCHEMA_LENGTH) })]);
    expect("error" in bigSchema && bigSchema.error).toContain("exceeds");
  });

  it("accepts a tool with no description at all", () => {
    // Common in practice -- clients often put all the detail in `parameters`.
    const parsed = parseCallerTools([{ type: "function", function: { name: "search_docs" } }]);
    expect("error" in parsed).toBe(false);
    if ("error" in parsed) return;
    expect(parsed.tools[0]!.description).toBe("");
    // Absent `parameters` still produces a usable object schema.
    expect(JSON.parse(parsed.tools[0]!.parametersJson)).toEqual({ properties: {}, type: "object" });
  });

  describe("tool_choice", () => {
    it("maps the string forms", () => {
      expect(parseCallerTools([tool("f")], "auto")).toMatchObject({ choice: { kind: "auto" } });
      expect(parseCallerTools([tool("f")], "none")).toMatchObject({ choice: { kind: "none" } });
      // "required" is carried as auto + a directive flag, since the planner
      // cannot be made to guarantee a call (docs/adr/0035 §5).
      expect(parseCallerTools([tool("f")], "required")).toMatchObject({ choice: { kind: "auto", required: true } });
    });

    it("maps a named function", () => {
      expect(parseCallerTools([tool("f"), tool("g")], { type: "function", function: { name: "g" } })).toMatchObject({
        choice: { kind: "function", name: "g" },
      });
    });

    it("rejects a named function that isn't on offer", () => {
      // Otherwise the caller has asked for something that cannot happen and
      // would get a silently ordinary answer instead.
      const parsed = parseCallerTools([tool("f")], { type: "function", function: { name: "missing" } });
      expect("error" in parsed && parsed.error).toContain('not present in tools');
    });

    it("rejects unknown forms", () => {
      expect("error" in parseCallerTools([tool("f")], "sometimes")).toBe(true);
      expect("error" in parseCallerTools([tool("f")], { type: "retrieval" })).toBe(true);
    });

    it("validates tool_choice even when no tools were sent", () => {
      expect("error" in parseCallerTools(undefined, "sometimes")).toBe(true);
    });
  });
});
