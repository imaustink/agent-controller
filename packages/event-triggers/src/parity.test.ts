// Runs every entry of fixtures/cel-parity.json — the executable definition of
// docs/event-triggers.md §3-§4, shared with the Temporal engine's Go tests.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  celTypeOf,
  compileTrigger,
  evaluate,
  fromTypedParam,
  renderTemplate,
  selectTrigger,
  toJsonValue,
  type Envelope,
  type EventTriggerResource,
  type JsonValue,
  type TypedParam,
} from "./index.js";

interface Fixture {
  envelopes: Record<string, Envelope>;
  cases: Array<{
    name: string;
    envelope: string;
    expr: string;
    expect: { value?: JsonValue; type?: string; error?: boolean };
  }>;
  templates: Array<{ name: string; template: string; params: Record<string, TypedParam>; expect: string }>;
  matching: Array<{
    name: string;
    envelope: string;
    callerSessionId?: string;
    triggers: Array<{ name: string } & EventTriggerResource["spec"]>;
    expect: {
      error?: boolean;
      trigger?: string | null;
      params?: Record<string, TypedParam>;
      stringParams?: Record<string, string>;
      toolInput?: string;
      sessionId?: string;
      prompt?: string;
      reply?: JsonValue;
    };
  }>;
}

const fixture = JSON.parse(
  readFileSync(new URL("../fixtures/cel-parity.json", import.meta.url), "utf8"),
) as Fixture;

function envelope(name: string): Envelope {
  const env = fixture.envelopes[name];
  if (!env) throw new Error(`fixture references unknown envelope ${name}`);
  return env;
}

describe("cel-parity fixture: cases", () => {
  it("has cases", () => expect(fixture.cases.length).toBeGreaterThan(40));

  for (const c of fixture.cases) {
    it(c.name, () => {
      const r = evaluate(c.expr, envelope(c.envelope));
      if (c.expect.error) {
        expect(r.ok, `expected an error, got ${JSON.stringify(r)}`).toBe(false);
        return;
      }
      if (!r.ok) throw new Error(`unexpected error: ${r.error}`);
      expect(c.expect.type, "every non-error case must pin a type").toBeDefined();
      expect(celTypeOf(r.value)).toBe(c.expect.type);
      expect(toJsonValue(r.value)).toEqual(c.expect.value);
    });
  }
});

describe("cel-parity fixture: templates", () => {
  for (const t of fixture.templates) {
    it(t.name, () => {
      const params = Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, fromTypedParam(v)]));
      expect(renderTemplate(t.template, params)).toBe(t.expect);
    });
  }
});

describe("cel-parity fixture: matching", () => {
  for (const m of fixture.matching) {
    it(m.name, () => {
      const compiled = m.triggers.map(({ name, ...spec }) =>
        compileTrigger({ metadata: { name }, spec: spec as EventTriggerResource["spec"] }),
      );
      const opts = m.callerSessionId ? { callerSessionId: m.callerSessionId } : {};
      const r = selectTrigger(compiled, envelope(m.envelope), opts);
      if (m.expect.error) {
        expect(r.status).toBe("failed");
        return;
      }
      if (m.expect.trigger === null) {
        expect(r).toEqual({ status: "ignored" });
        return;
      }
      if (r.status !== "matched") throw new Error(`expected a match, got ${JSON.stringify(r)}`);
      expect(r.trigger).toBe(m.expect.trigger);
      expect(r.params).toEqual(m.expect.params);
      expect(r.stringParams).toEqual(m.expect.stringParams);
      expect(r.sessionId).toBe(m.expect.sessionId);
      expect(r.prompt).toBe(m.expect.prompt);
      expect(r.reply).toEqual(m.expect.reply);
      if (m.expect.toolInput !== undefined) expect(r.toolInput).toBe(m.expect.toolInput);
    });
  }
});
