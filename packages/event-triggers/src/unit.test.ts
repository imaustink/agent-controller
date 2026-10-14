import { describe, expect, it, vi } from "vitest";
import {
  buildCronEnvelope,
  buildWebhookEnvelope,
  canonicalJson,
  celTypeOf,
  compileExpression,
  compileTrigger,
  evaluate,
  normalizeHeaders,
  normalizeJson,
  paramToString,
  parseBody,
  renderTemplate,
  selectTrigger,
  type Envelope,
  type EventTriggerResource,
} from "./index.js";

const NOW = new Date("2026-10-13T12:00:00.123Z");

function env(body: Envelope["body"], extra: Partial<Envelope> = {}): Envelope {
  return {
    source: "ci",
    kind: "webhook",
    id: "e-1",
    time: "2026-10-13T12:00:00Z",
    headers: {},
    body,
    sender: {},
    repository: "",
    ...extra,
  };
}

function trigger(name: string, spec: EventTriggerResource["spec"]): EventTriggerResource {
  return { metadata: { name }, spec };
}

describe("normalizeHeaders", () => {
  it("lower-cases, joins arrays and case-variant duplicates, drops credentials", () => {
    expect(
      normalizeHeaders(
        {
          "X-GitHub-Event": "issues",
          "Set-Thing": ["a", "b"],
          "x-dup": "1",
          "X-Dup": "2",
          Authorization: "Bearer s3cret",
          Cookie: "session=1",
          "X-Hub-Signature-256": "sha256=abc",
          "content-length": 12,
          "x-undefined": undefined,
        },
        ["x-hub-signature-256"],
      ),
    ).toEqual({ "x-github-event": "issues", "set-thing": "a, b", "x-dup": "1, 2", "content-length": "12" });
  });

  it("matches dropNames case-insensitively and always drops authorization/cookie", () => {
    const out = normalizeHeaders({ authorization: "x", cookie: "y", "X-Sig": "z", keep: "k" }, ["X-SIG"]);
    expect(out).toEqual({ keep: "k" });
  });

  it("treats a __proto__ header as data", () => {
    const out = normalizeHeaders({ ["__proto__"]: "x" } as Record<string, string>);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
  });
});

describe("parseBody", () => {
  it("parses application/json (with parameters)", () => {
    expect(parseBody(Buffer.from('{"a":1,"b":[true]}'), "Application/JSON; charset=utf-8")).toEqual({ a: 1, b: [true] });
  });
  it("keeps non-object JSON as-is", () => {
    expect(parseBody(Buffer.from("[1,2]"), "application/json")).toEqual([1, 2]);
  });
  it("falls back to text for malformed JSON", () => {
    expect(parseBody(Buffer.from("{nope"), "application/json")).toEqual({ text: "{nope" });
  });
  it("parses form bodies into string fields, first value wins", () => {
    expect(
      parseBody(Buffer.from("command=%2Ftriage&text=acme%2Fwidgets+7&text=second"), "application/x-www-form-urlencoded"),
    ).toEqual({ command: "/triage", text: "acme/widgets 7" });
  });
  it("wraps anything else as text", () => {
    expect(parseBody(Buffer.from("héllo"), "text/plain")).toEqual({ text: "héllo" });
    expect(parseBody(Buffer.from("{\"a\":1}"))).toEqual({ text: "{\"a\":1}" });
  });
  it("respects Uint8Array views", () => {
    const backing = Buffer.from("xx{\"a\":2}yy");
    expect(parseBody(backing.subarray(2, 9), "application/json")).toEqual({ a: 2 });
  });
});

describe("build*Envelope", () => {
  it("builds a webhook envelope", () => {
    expect(
      buildWebhookEnvelope({
        source: "github",
        id: "d-1",
        headers: { "x-github-event": "issues" },
        body: { a: 1 },
        sender: { login: "octocat", isBot: false },
        repository: "acme/widgets",
        now: NOW,
      }),
    ).toEqual({
      source: "github",
      kind: "webhook",
      id: "d-1",
      time: "2026-10-13T12:00:00Z",
      headers: { "x-github-event": "issues" },
      body: { a: 1 },
      sender: { login: "octocat", isBot: false },
      repository: "acme/widgets",
    });
  });
  it("defaults id to a uuid, sender to {} and repository to \"\"", () => {
    const e = buildWebhookEnvelope({ source: "s", headers: {}, body: {}, now: NOW });
    expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(e.sender).toEqual({});
    expect(e.repository).toBe("");
  });
  it("builds a cron envelope", () => {
    expect(buildCronEnvelope({ source: "nightly-sweep", payload: { repo: "acme/widgets" }, now: NOW })).toEqual({
      source: "nightly-sweep",
      kind: "cron",
      id: "nightly-sweep-1791892800",
      time: "2026-10-13T12:00:00Z",
      headers: {},
      body: { repo: "acme/widgets" },
      sender: {},
      repository: "",
    });
    expect(buildCronEnvelope({ source: "s", now: NOW }).body).toEqual({});
  });
});

describe("values", () => {
  it("normalizeJson: integral → int, fractional/out-of-range → double", () => {
    expect(normalizeJson({ a: 1, b: 1.5, c: 1e300, d: [2] })).toEqual({ a: 1n, b: 1.5, c: 1e300, d: [2n] });
    expect(celTypeOf(normalizeJson(1e300))).toBe("double");
  });
  it("normalizeJson keeps __proto__ as an ordinary key", () => {
    const v = normalizeJson(JSON.parse('{"__proto__": {"polluted": true}}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(evaluate('body["__proto__"].polluted', env(JSON.parse('{"__proto__": {"polluted": true}}')))).toEqual({
      ok: true,
      value: true,
    });
    expect(Object.keys(v)).toEqual(["__proto__"]);
  });
  it("paramToString distinguishes int and double", () => {
    expect(paramToString(5n)).toBe("5");
    expect(paramToString(5)).toBe("5");
    expect(paramToString(0.5)).toBe("0.5");
    expect(paramToString(null)).toBe("");
    expect(paramToString(9007199254740993n)).toBe("9007199254740993");
  });
  it("canonicalJson sorts nested keys and rejects unsupported values", () => {
    expect(canonicalJson({ b: [{ z: 1n, y: 2.5 }], a: null })).toBe('{"a":null,"b":[{"y":2.5,"z":1}]}');
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow();
    expect(() => canonicalJson(new Date())).toThrow();
  });
  it("renderTemplate tolerates whitespace and leaves malformed placeholders alone", () => {
    expect(renderTemplate("{{  a\t}} {{a b}} {a} {{}}", { a: "x" })).toBe("x {{a b}} {a} {{}}");
    expect(renderTemplate("{{toString}}", {})).toBe("{{toString}}");
  });
});

describe("compileExpression / evaluate", () => {
  it("rejects unknown variables at compile time", () => {
    expect(compileExpression("nope == 1").ok).toBe(false);
  });
  it("rejects statically ill-typed expressions", () => {
    expect(compileExpression('headers["a"] == 1').ok).toBe(false);
  });
  it("accepts heterogeneous literals like cel-go", () => {
    const r = evaluate('[1, "a"]', env({}));
    expect(r).toEqual({ ok: true, value: [1n, "a"] });
  });
  it("evaluates a precompiled expression", () => {
    const c = compileExpression("body.n + 1");
    if (!c.ok) throw new Error(c.error);
    expect(evaluate(c.expression, env({ n: 41 }))).toEqual({ ok: true, value: 42n });
  });
});

describe("compileTrigger", () => {
  it("is ready with a valid spec and carries the target", () => {
    const t = compileTrigger(
      trigger("r", { priority: 5, match: { cel: "true" }, target: { agentRef: "swe", readOnly: true, promptTemplate: "p" } }),
    );
    expect(t.ready).toBe(true);
    expect(t.priority).toBe(5);
    expect(t.target).toEqual({ kind: "agent", ref: "swe", readOnly: true, promptTemplate: "p" });
  });
  it.each([
    ["no target kind", { target: { promptTemplate: "p" } }],
    ["two target kinds", { target: { agentRef: "a", skillRef: "s", promptTemplate: "p" } }],
    ["missing promptTemplate", { target: { agentRef: "a" } }],
    ["match does not compile", { match: { cel: "body.action ==" }, target: { orchestrator: {}, promptTemplate: "p" } }],
    ["match statically non-bool", { match: { cel: '"x"' }, target: { orchestrator: {}, promptTemplate: "p" } }],
    ["param does not compile", { params: { a: "body." }, target: { orchestrator: {}, promptTemplate: "p" } }],
  ] as Array<[string, EventTriggerResource["spec"]]>)("is not ready: %s", (_, spec) => {
    const t = compileTrigger(trigger("x", spec));
    expect(t.ready).toBe(false);
    expect(t.error).toBeTruthy();
  });
  it("toolRef does not need a promptTemplate", () => {
    expect(compileTrigger(trigger("t", { target: { toolRef: "http-get" } })).ready).toBe(true);
  });
});

describe("selectTrigger", () => {
  it("returns typed toolArgs and readOnly for a toolRef target", () => {
    const r = selectTrigger(
      [compileTrigger(trigger("t", { params: { a: "body.a", d: "body.d", l: "body.l" }, target: { toolRef: "x", readOnly: true } }))],
      env({ a: 3, d: 1.5, l: [1, "x"] }),
    );
    if (r.status !== "matched") throw new Error(JSON.stringify(r));
    expect(r.toolArgs).toEqual({ a: 3, d: 1.5, l: [1, "x"] });
    expect(r.toolInput).toBe('{"a":3,"d":1.5,"l":[1,"x"]}');
    expect(r.target).toEqual({ kind: "tool", ref: "x", readOnly: true });
    expect(r.prompt).toBe("");
  });
  it("toolInput is {} without params", () => {
    const r = selectTrigger([compileTrigger(trigger("t", { target: { toolRef: "x" } }))], env({}));
    expect(r.status === "matched" && r.toolInput).toBe("{}");
  });
  it("reports match errors through onMatchError", () => {
    const onMatchError = vi.fn();
    const r = selectTrigger(
      [compileTrigger(trigger("t", { match: { cel: "body.missing == 1" }, target: { orchestrator: {}, promptTemplate: "p" } }))],
      env({}),
      { onMatchError },
    );
    expect(r).toEqual({ status: "ignored" });
    expect(onMatchError).toHaveBeenCalledWith("t", expect.stringContaining("missing"));
  });
  it("fails when issueNumber does not render to a positive integer", () => {
    const r = selectTrigger(
      [
        compileTrigger(
          trigger("t", {
            params: { n: "body.n" },
            target: { orchestrator: {}, promptTemplate: "p" },
            reply: { github: { repository: "a/b", issueNumber: "{{n}}" } },
          }),
        ),
      ],
      env({ n: "abc" }),
    );
    expect(r).toMatchObject({ status: "failed", trigger: "t" });
  });
  it("fails when a param is not JSON-representable", () => {
    const r = selectTrigger(
      [compileTrigger(trigger("t", { params: { ts: 'timestamp("2024-01-01T00:00:00Z")' }, target: { toolRef: "x" } }))],
      env({}),
    );
    expect(r.status).toBe("failed");
  });
  it("never templates the http reply url", () => {
    const r = selectTrigger(
      [
        compileTrigger(
          trigger("t", {
            params: { h: "body.h" },
            target: { orchestrator: {}, promptTemplate: "p" },
            reply: { http: { url: "http://x/{{h}}", secretRef: { name: "s", key: "k" } } },
          }),
        ),
      ],
      env({ h: "evil" }),
    );
    expect(r.status === "matched" && r.reply).toEqual({ http: { url: "http://x/{{h}}", secretRef: { name: "s", key: "k" } } });
  });
  it("falls back from an empty rendered sessionKey", () => {
    const r = selectTrigger(
      [compileTrigger(trigger("t", { sessionKey: "{{k}}", params: { k: "body.k" }, target: { orchestrator: {}, promptTemplate: "p" } }))],
      env({ k: null }),
    );
    expect(r.status === "matched" && r.sessionId).toBe("event:ci:e-1");
  });
});
