// Runs the shared wire-contract fixtures (conformance/*.json) against the
// generated TypeScript + protovalidate. See conformance/README.md for the
// fixture format and what each check proves.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DescMessage, JsonValue } from "@bufbuild/protobuf";
import { describe, expect, test } from "vitest";
import { AgentDownMessageSchema, AgentUpMessageSchema, EventSchema, TurnEventSchema, decode, encode } from "./index.js";

const IMPL = "proto-ts";
const KNOWN_IMPLS = new Set(["proto-ts", "proto-go", "zod"]);
const DIR = fileURLToPath(new URL("../conformance/", import.meta.url));

const SCHEMAS: Record<string, DescMessage> = {
  [EventSchema.typeName]: EventSchema,
  [TurnEventSchema.typeName]: TurnEventSchema,
  [AgentUpMessageSchema.typeName]: AgentUpMessageSchema,
  [AgentDownMessageSchema.typeName]: AgentDownMessageSchema,
};

interface Case {
  name: string;
  valid: boolean;
  json: JsonValue;
  roundTrip?: boolean;
  divergences?: Record<string, string>;
}

/** Same object, ignoring key order; an empty array is the same as an absent key. */
function normalize(v: JsonValue): JsonValue {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [k, val] of Object.entries(v)) {
      if (Array.isArray(val) && val.length === 0) continue;
      out[k] = normalize(val as JsonValue);
    }
    return out;
  }
  return v;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

test("every fixture file targets a known message", () => {
  expect(files.length).toBeGreaterThan(0);
  for (const f of files) {
    const { message } = JSON.parse(readFileSync(DIR + f, "utf8"));
    expect(SCHEMAS, `${f} names ${message}`).toHaveProperty([message]);
  }
});

for (const file of files) {
  const fixture = JSON.parse(readFileSync(DIR + file, "utf8")) as { message: string; cases: Case[] };
  const schema = SCHEMAS[fixture.message];
  if (!schema) continue;

  describe(file, () => {
    test("case names are unique and divergences name known implementations", () => {
      const names = fixture.cases.map((c) => c.name);
      expect(new Set(names).size).toBe(names.length);
      for (const c of fixture.cases) {
        for (const impl of Object.keys(c.divergences ?? {})) {
          expect(KNOWN_IMPLS.has(impl), `"${c.name}" lists unknown implementation "${impl}"`).toBe(true);
        }
      }
    });

    for (const c of fixture.cases) {
      const diverges = Boolean(c.divergences?.[IMPL]);
      test(`${c.valid ? "accepts" : "rejects"} ${c.name}${diverges ? ` (known ${IMPL} divergence)` : ""}`, () => {
        const result = decode(schema, c.json);
        const expected = diverges ? !c.valid : c.valid;
        expect(result.ok, result.ok ? "accepted" : `rejected: ${result.error}`).toBe(expected);

        if (result.ok && c.valid && !diverges && c.roundTrip !== false) {
          expect(normalize(encode(schema, result.message))).toEqual(normalize(c.json));
        }
      });
    }
  });
}
