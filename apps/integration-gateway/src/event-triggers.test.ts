import { describe, expect, it } from "vitest";
import type { Envelope, EventTriggerResource } from "@controller-agent/event-triggers";
import { CrdEventTriggerRegistry, couldMatchBeforeSender, readsResolvedFields, StaticEventTriggerTable } from "./event-triggers.js";
import type { CrdWatchApi } from "./crd-table.js";

const trigger = (name: string, spec: Partial<EventTriggerResource["spec"]>): EventTriggerResource => ({
  metadata: { name },
  spec: { target: { agentRef: "swe", promptTemplate: "go" }, ...spec },
});

const envelope = (body: Record<string, unknown>, headers: Record<string, string> = {}): Envelope =>
  ({ source: "github", kind: "webhook", id: "d1", time: "2026-01-01T00:00:00Z", headers, body, sender: {}, repository: "" }) as Envelope;

const all = (resources: EventTriggerResource[]) => new StaticEventTriggerTable(resources).all();

describe("readsResolvedFields", () => {
  it.each([
    ["sender.login == 'alice'", true],
    ["repository == 'acme/widgets'", true],
    ["has(sender.isBot) && body.x", true],
    ["body . x || repository.startsWith('acme/')", true],
    ["body.repository.full_name == 'acme/widgets'", false],
    ["body . sender . login == 'x'", false],
    ['body.label.name == "sender" || headers["repository"] == \'repository\'', false],
    ['body.x == """sender"""', false],
    ["body.x == r'sender' // sender in a comment", false],
    ["senders.size() > 0 || body.repositoryName == ''", false],
  ])("%s -> %s", (expr, want) => {
    expect(readsResolvedFields(expr)).toBe(want);
  });
});

describe("couldMatchBeforeSender", () => {
  const labeled = trigger("review", {
    sourceRef: "github",
    match: { cel: 'headers["x-github-event"] == "pull_request" && body.action == "labeled"' },
  });

  it("false when every trigger for the source evaluates false", () => {
    expect(couldMatchBeforeSender(all([labeled]), envelope({ action: "opened" }, { "x-github-event": "pull_request" }))).toBe(false);
  });

  it("true when one evaluates true", () => {
    expect(couldMatchBeforeSender(all([labeled]), envelope({ action: "labeled" }, { "x-github-event": "pull_request" }))).toBe(true);
  });

  it("true for a trigger with no match (matches everything from its source) or no sourceRef", () => {
    expect(couldMatchBeforeSender(all([trigger("any", { sourceRef: "github" })]), envelope({}))).toBe(true);
    expect(couldMatchBeforeSender(all([trigger("any-source", {})]), envelope({}))).toBe(true);
  });

  it("true for a trigger reading sender/repository, whatever the rest says", () => {
    expect(couldMatchBeforeSender(all([trigger("s", { sourceRef: "github", match: { cel: 'sender.login == "x"' } })]), envelope({}))).toBe(true);
  });

  it("ignores triggers for other sources, and ones that don't compile (the orchestrator never matches those either)", () => {
    expect(couldMatchBeforeSender(all([trigger("slack", { sourceRef: "slack" })]), envelope({}))).toBe(false);
    expect(couldMatchBeforeSender(all([trigger("broken", { sourceRef: "github", match: { cel: "body.(" } })]), envelope({}))).toBe(false);
  });

  it("an evaluation error is a non-match, as in selectTrigger", () => {
    expect(couldMatchBeforeSender(all([trigger("e", { sourceRef: "github", match: { cel: "body.missing.deeper == 1" } })]), envelope({}))).toBe(false);
  });
});

describe("CrdEventTriggerRegistry", () => {
  it("is unknown (undefined) until the first list lands, then serves it; a failed list never throws", async () => {
    let fail = true;
    const api = {
      listNamespacedCustomObject: async () => {
        if (fail) throw new Error("forbidden");
        return { items: [trigger("review", { sourceRef: "github" })], metadata: { resourceVersion: "1" } };
      },
    };
    const watch: CrdWatchApi = { watch: async () => ({ abort() {} }) };
    const logs: string[] = [];
    const registry = new CrdEventTriggerRegistry({ namespace: "ns", group: "g", version: "v1", api, watch, reconnectDelayMs: 1, log: (m) => logs.push(m) });
    registry.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(registry.all()).toBeUndefined();
    expect(logs.join("\n")).toMatch(/EventTrigger list failed/);
    fail = false;
    await new Promise((r) => setTimeout(r, 20));
    expect([...(registry.all() ?? [])].map((t) => t.name)).toEqual(["review"]);
    registry.stop();
  });
});
