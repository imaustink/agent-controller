// Runs the shared wire-contract fixtures (framework/protocol/conformance) against
// the hand-written zod schemas, so the canonical .proto and the TypeScript
// runtime parser cannot drift apart unnoticed (ADR 0047). Verdicts only: zod
// strips unknown keys rather than re-encoding, so there is no round trip here.

import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ZodTypeAny } from "zod";
import { describe, expect, test } from "vitest";
import { AgentDownMessageSchema, AgentUpMessageSchema, EventSchema, TurnEventSchema } from "./index.js";

const IMPL = "zod";
const DIR = fileURLToPath(new URL("../../../framework/protocol/conformance/", import.meta.url));

const SCHEMAS: Record<string, ZodTypeAny> = {
  "agentcontroller.protocol.v1.Event": EventSchema,
  "agentcontroller.protocol.v1.TurnEvent": TurnEventSchema,
  "agentcontroller.protocol.v1.AgentUpMessage": AgentUpMessageSchema,
  "agentcontroller.protocol.v1.AgentDownMessage": AgentDownMessageSchema,
};

interface Case {
  name: string;
  valid: boolean;
  json: unknown;
  divergences?: Record<string, string>;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));

test("every fixture file targets a message with a zod schema", () => {
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
    for (const c of fixture.cases) {
      const diverges = Boolean(c.divergences?.[IMPL]);
      test(`${c.valid ? "accepts" : "rejects"} ${c.name}${diverges ? ` (known ${IMPL} divergence)` : ""}`, () => {
        const result = schema.safeParse(c.json);
        const expected = diverges ? !c.valid : c.valid;
        expect(result.success, result.success ? "accepted" : `rejected: ${result.error.message}`).toBe(expected);
      });
    }
  });
}
