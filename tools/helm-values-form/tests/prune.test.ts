import { describe, expect, it } from "vitest";
import {
  asSchema,
  collapseUnion,
  pruneToOverrides,
  resolvePath,
  resolveRef,
  typeOf,
} from "../src/prune.js";
import type { JSONSchema } from "../src/types.js";

const schema: JSONSchema = {
  type: "object",
  properties: {
    replicaCount: { type: "integer", default: 1 },
    enabled: { type: "boolean", default: true },
    tag: { type: "string", default: "0.1.0" },
    note: { type: "string" },
    args: { type: "array", items: { type: "string" }, default: ["--a"] },
    freeArgs: { type: "array", items: { type: "string" } },
    podAnnotations: { type: "object", additionalProperties: { type: "string" }, default: {} },
    nodeSelector: { type: "object", additionalProperties: { type: "string" } },
    secretName: { type: ["string", "null"], default: "tls-secret" },
    optionalName: { type: ["string", "null"] },
    resources: {
      type: "object",
      properties: {
        limits: {
          type: "object",
          properties: {
            cpu: { type: "string", default: "500m" },
            memory: { type: "string", default: "512Mi" },
          },
        },
      },
    },
    deep: {
      type: "object",
      properties: {
        one: {
          type: "object",
          properties: {
            two: { type: "object", properties: { three: { type: "string", default: "d" } } },
          },
        },
      },
    },
  },
};

describe("values equal to their default", () => {
  it("are dropped", () => {
    expect(pruneToOverrides({ replicaCount: 1, tag: "0.1.0", enabled: true }, schema)).toEqual({});
  });

  it("are kept when they differ", () => {
    expect(pruneToOverrides({ replicaCount: 3, tag: "0.1.0" }, schema)).toEqual({
      replicaCount: 3,
    });
  });

  it("compare deeply, not by reference", () => {
    expect(pruneToOverrides({ args: ["--a"] }, schema)).toEqual({});
    expect(pruneToOverrides({ args: ["--a", "--b"] }, schema)).toEqual({ args: ["--a", "--b"] });
    expect(pruneToOverrides({ podAnnotations: {} }, schema)).toEqual({});
  });
});

describe("meaningful overrides that look like emptiness", () => {
  it("keeps false when the default is true", () => {
    expect(pruneToOverrides({ enabled: false }, schema)).toEqual({ enabled: false });
  });

  it("keeps 0 when the default is 1", () => {
    expect(pruneToOverrides({ replicaCount: 0 }, schema)).toEqual({ replicaCount: 0 });
  });

  it("keeps an emptied array when the default is non-empty", () => {
    expect(pruneToOverrides({ args: [] }, schema)).toEqual({ args: [] });
  });

  it("keeps an explicit null when the default is a string", () => {
    expect(pruneToOverrides({ secretName: null }, schema)).toEqual({ secretName: null });
  });

  it("keeps an emptied string when the default is non-empty", () => {
    expect(pruneToOverrides({ tag: "" }, schema)).toEqual({ tag: "" });
  });
});

describe("emptiness with no default to differ from", () => {
  // With no `default` in the schema there is nothing for these to override, so
  // they are "left blank" rather than "cleared".
  it("drops an empty string", () => {
    expect(pruneToOverrides({ note: "" }, schema)).toEqual({});
  });

  it("drops an empty array and an empty map", () => {
    expect(pruneToOverrides({ freeArgs: [], nodeSelector: {} }, schema)).toEqual({});
  });

  it("keeps an explicit null where the schema permits null, even with no default", () => {
    // Deliberately different from the empty cases above. `null` cannot be
    // produced by leaving a control alone -- it takes checking a "set to null"
    // box -- and a schema listing "null" among the valid types is saying null
    // means something. Dropping it would silently discard the choice.
    expect(pruneToOverrides({ optionalName: null }, schema)).toEqual({ optionalName: null });
  });

  it("still drops a null where the schema does not permit one", () => {
    // Not a choice the form can produce; treat it as absence rather than
    // emitting a value the chart would reject.
    expect(pruneToOverrides({ note: null }, schema)).toEqual({});
  });

  it("still keeps a non-empty value at the same paths", () => {
    expect(pruneToOverrides({ note: "hi", freeArgs: ["--x"] }, schema)).toEqual({
      note: "hi",
      freeArgs: ["--x"],
    });
  });
});

describe("objects", () => {
  it("are dropped when pruning empties them", () => {
    expect(pruneToOverrides({ resources: { limits: { cpu: "500m", memory: "512Mi" } } }, schema))
      .toEqual({});
  });

  it("keep the parent chain of a value nested three deep", () => {
    expect(pruneToOverrides({ deep: { one: { two: { three: "changed" } } } }, schema)).toEqual({
      deep: { one: { two: { three: "changed" } } },
    });
  });

  it("keep only the branch that changed", () => {
    const values = {
      resources: { limits: { cpu: "500m", memory: "1Gi" } },
      deep: { one: { two: { three: "d" } } },
    };
    expect(pruneToOverrides(values, schema)).toEqual({ resources: { limits: { memory: "1Gi" } } });
  });

  it("drop empty maps nested inside a free-form map", () => {
    expect(pruneToOverrides({ podAnnotations: { a: "1", b: "" } }, schema)).toEqual({
      podAnnotations: { a: "1" },
    });
  });

  it("drop an open map emptied down to its `{}` default", () => {
    // A user who adds an annotation row and leaves the value blank must not get
    // a redundant `podAnnotations: {}` -- that restates the chart default `{}`,
    // the exact thing the pruner exists to eliminate.
    expect(pruneToOverrides({ podAnnotations: { k: "" } }, schema)).toEqual({});
  });

  it("keep an open map the user cleared when the default is populated", () => {
    // Here `{}` is a real override: the chart populates the map, and clearing it
    // is a deliberate choice that must survive.
    const populated: JSONSchema = {
      type: "object",
      properties: {
        labels: {
          type: "object",
          additionalProperties: { type: "string" },
          default: { app: "demo" },
        },
      },
    };
    expect(pruneToOverrides({ labels: { app: "" } }, populated)).toEqual({ labels: {} });
  });
});

describe("key order", () => {
  it("follows the schema, not the order the values arrived in", () => {
    // render.ts collects in binding order, which is schema order -- but a
    // reordered input must still come out schema-ordered, since that ordering is
    // what makes the emitted YAML stable enough to commit.
    const values = { tag: "9.9.9", replicaCount: 7, note: "n" };
    expect(Object.keys(pruneToOverrides(values, schema))).toEqual([
      "replicaCount",
      "tag",
      "note",
    ]);
  });

  it("puts user-keyed map entries after schema keys, in entry order", () => {
    const out = pruneToOverrides({ podAnnotations: { z: "1", a: "2" } }, schema);
    expect(Object.keys(out.podAnnotations as object)).toEqual(["z", "a"]);
  });
});

describe("schema helpers", () => {
  const withDefs: JSONSchema = {
    type: "object",
    properties: { tls: { $ref: "#/$defs/tls" } },
    $defs: {
      tls: { type: "object", properties: { enabled: { type: "boolean", default: false } } },
    },
  };

  it("resolves a local $ref", () => {
    expect(asSchema(resolveRef({ $ref: "#/$defs/tls" }, withDefs)?.properties?.enabled)?.type).toBe(
      "boolean",
    );
  });

  it("returns null for a remote $ref rather than fetching it", () => {
    expect(resolveRef({ $ref: "https://example.com/s.json#/x" }, withDefs)).toBeNull();
  });

  it("returns null on a cyclic $ref instead of recursing forever", () => {
    const cyclic: JSONSchema = { $defs: { a: { $ref: "#/$defs/a" } } };
    expect(resolveRef({ $ref: "#/$defs/a" }, cyclic)).toBeNull();
  });

  it("resolves dotted allowlist paths, and reports the ones that do not", () => {
    expect(resolvePath(schema, "resources.limits.cpu")?.default).toBe("500m");
    expect(resolvePath(schema, "deep.one.two.three")?.type).toBe("string");
    expect(resolvePath(schema, "resources.limits.gpu")).toBeNull();
    expect(resolvePath(schema, "nope")).toBeNull();
    // A path into a free-form map's key space is not a schema property.
    expect(resolvePath(schema, "podAnnotations.foo")).toBeNull();
  });

  it("takes the first non-null entry of an array type", () => {
    expect(typeOf({ type: ["string", "null"] })).toBe("string");
    expect(typeOf({ type: ["null", "integer"] })).toBe("integer");
  });

  it("collapses an all-scalar anyOf to its first branch", () => {
    const collapsed = collapseUnion(
      { title: "T", anyOf: [{ type: "string", minLength: 2 }, { type: "null" }] },
      {},
    );
    expect(collapsed?.type).toEqual(["string", "null"]);
    expect(collapsed?.minLength).toBe(2);
    expect(collapsed?.title).toBe("T");
  });

  it("refuses a union with a non-scalar branch", () => {
    expect(collapseUnion({ oneOf: [{ type: "string" }, { type: "object" }] }, {})).toBeNull();
  });
});

describe("values with no schema behind them", () => {
  it("survive if non-empty and are compacted if not", () => {
    expect(pruneToOverrides({ unknown: "kept", blank: "", hollow: { a: {} } }, schema)).toEqual({
      unknown: "kept",
    });
  });
});
