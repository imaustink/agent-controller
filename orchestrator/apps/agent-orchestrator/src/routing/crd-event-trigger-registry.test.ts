import { describe, expect, it, vi } from "vitest";
import type { Envelope, EventTriggerResource } from "@controller-agent/event-triggers";
import type { WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import { CrdEventTriggerRegistry, parseEnvelope } from "./crd-event-trigger-registry.js";

const GROUP = "core.controller-agent.dev";

/** What core-controller writes once CEL compiles and the refs resolve, for generation 1. */
const READY: EventTriggerResource["status"] = { conditions: [{ type: "Ready", status: "True", observedGeneration: 1 }] };

function envelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    source: "github",
    kind: "webhook",
    id: "delivery-1",
    time: "2026-10-13T00:00:00Z",
    headers: { "x-github-event": "pull_request" },
    body: { action: "labeled", label: { name: "ai-review" }, repository: { full_name: "acme/widgets" }, pull_request: { number: 7 } },
    sender: { login: "imaustink", isBot: false },
    repository: "acme/widgets",
    ...overrides,
  };
}

const review: EventTriggerResource = {
  metadata: { name: "github-pr-review", generation: 1 },
  spec: {
    sourceRef: "github",
    match: { cel: 'headers["x-github-event"] == "pull_request" && body.action == "labeled" && body.label.name == "ai-review"' },
    params: { repo: "body.repository.full_name", number: "body.pull_request.number" },
    sessionKey: "github:{{repo}}#{{number}}",
    target: { agentRef: "claude-code-swe-agent", readOnly: true, promptTemplate: "Review {{repo}}#{{number}}" },
  },
  status: READY,
};

async function registryWith(items: EventTriggerResource[]): Promise<CrdEventTriggerRegistry> {
  const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn().mockResolvedValue({ items }) };
  const registry = new CrdEventTriggerRegistry("default", GROUP, "v1alpha1", api);
  await registry.listAll();
  return registry;
}

describe("CrdEventTriggerRegistry", () => {
  it("lists EventTrigger custom resources and compiles them", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [review] });
    const registry = new CrdEventTriggerRegistry("default", GROUP, "v1alpha1", { listNamespacedCustomObject });

    const triggers = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: GROUP,
      version: "v1alpha1",
      namespace: "default",
      plural: "eventtriggers",
    });
    expect(triggers.map((t) => [t.name, t.ready])).toEqual([["github-pr-review", true]]);
  });

  it("selects the matching trigger with its params, session id and target", async () => {
    const registry = await registryWith([review]);

    const selected = registry.select(envelope());

    expect(selected).toMatchObject({
      status: "matched",
      trigger: "github-pr-review",
      target: { kind: "agent", ref: "claude-code-swe-agent", readOnly: true },
      stringParams: { repo: "acme/widgets", number: "7" },
      sessionId: "github:acme/widgets#7",
      prompt: "Review acme/widgets#7",
    });
  });

  it("ignores an event no trigger matches -- never a fallback", async () => {
    const registry = await registryWith([review]);

    expect(registry.select(envelope({ body: { action: "labeled", label: { name: "bug" } } }))).toEqual({ status: "ignored" });
    expect(registry.select(envelope({ source: "slack" }))).toEqual({ status: "ignored" });
  });

  it("never matches a trigger whose CEL does not compile (fail closed)", async () => {
    const broken: EventTriggerResource = {
      metadata: { name: "broken", generation: 1 },
      spec: { match: { cel: "body.action ==" }, target: { orchestrator: {}, promptTemplate: "x" } },
      // Even a (stale) Ready=True cannot override a failed local compile.
      status: READY,
    };
    const registry = await registryWith([broken]);

    expect(registry.list()[0]!.ready).toBe(false);
    expect(registry.select(envelope())).toEqual({ status: "ignored" });
  });

  it.each([
    ["no status at all (not reconciled yet)", undefined],
    ["Ready=False (a target ref does not resolve)", { conditions: [{ type: "Ready", status: "False" as const }] }],
    ["Ready=Unknown", { conditions: [{ type: "Ready", status: "Unknown" as const }] }],
  ])("never matches a trigger the controller has not marked Ready: %s", async (_label, status) => {
    const registry = await registryWith([{ ...review, status }]);

    expect(registry.list()[0]!.ready).toBe(true); // compiles fine locally...
    expect(registry.select(envelope())).toEqual({ status: "ignored" }); // ...but is not offered
  });

  it("never matches an edited trigger whose Ready condition predates the edit", async () => {
    // The spec edit bumped the generation to 2; the controller has not yet
    // re-checked it, so Ready=True is the previous spec's verdict.
    const edited: EventTriggerResource = { ...review, metadata: { name: "github-pr-review", generation: 2 } };
    const registry = await registryWith([edited]);

    expect(registry.list()[0]!.ready).toBe(true);
    expect(registry.select(envelope())).toEqual({ status: "ignored" });

    const rechecked = await registryWith([
      { ...edited, status: { conditions: [{ type: "Ready", status: "True", observedGeneration: 2 }] } },
    ]);
    expect(rechecked.select(envelope())).toMatchObject({ status: "matched" });
  });

  it("re-evaluates controller readiness on every MODIFIED event", () => {
    let onEvent!: (phase: string, obj: unknown) => void;
    const watchFn: WatchCrdFn = (_opts, cb) => {
      onEvent = cb as (phase: string, obj: unknown) => void;
      return { stop: vi.fn() };
    };
    const registry = new CrdEventTriggerRegistry("default", GROUP, "v1alpha1", { listNamespacedCustomObject: vi.fn() }, watchFn);
    registry.watch(() => {});

    onEvent("ADDED", { ...review, status: undefined });
    expect(registry.select(envelope())).toEqual({ status: "ignored" });
    onEvent("MODIFIED", review);
    expect(registry.select(envelope())).toMatchObject({ status: "matched" });
    onEvent("MODIFIED", { ...review, status: { conditions: [{ type: "Ready", status: "False" }] } });
    expect(registry.select(envelope())).toEqual({ status: "ignored" });
  });

  it("uses the caller's session id when the trigger has no sessionKey", async () => {
    const noKey: EventTriggerResource = {
      metadata: { name: "any-github", generation: 1 },
      spec: { sourceRef: "github", target: { orchestrator: {}, promptTemplate: "hi" } },
      status: READY,
    };
    const registry = await registryWith([noKey]);

    expect(registry.select(envelope(), { callerSessionId: "caller-session" })).toMatchObject({ sessionId: "caller-session" });
    expect(registry.select(envelope())).toMatchObject({ sessionId: "event:github:delivery-1" });
  });

  describe("watch", () => {
    it("upserts on ADDED/MODIFIED and removes on DELETED", () => {
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (opts, cb) => {
        expect(opts.plural).toBe("eventtriggers");
        onEvent = cb as (phase: string, obj: unknown) => void;
        return { stop: vi.fn() };
      };
      const registry = new CrdEventTriggerRegistry("default", GROUP, "v1alpha1", { listNamespacedCustomObject: vi.fn() }, watchFn);
      registry.watch(() => {});

      onEvent("ADDED", review);
      expect(registry.select(envelope())).toMatchObject({ status: "matched", trigger: "github-pr-review" });

      onEvent("DELETED", review);
      expect(registry.select(envelope())).toEqual({ status: "ignored" });
    });

    it("throws when constructed without a watchFn", () => {
      const registry = new CrdEventTriggerRegistry("default", GROUP, "v1alpha1", { listNamespacedCustomObject: vi.fn() });
      expect(() => registry.watch(() => {})).toThrow();
    });
  });
});

describe("parseEnvelope", () => {
  it("accepts a well-formed envelope and defaults the optional fields", () => {
    expect(parseEnvelope({ source: "nightly", kind: "cron", id: "nightly-1", time: "2026-10-13T07:00:00Z" })).toEqual({
      source: "nightly",
      kind: "cron",
      id: "nightly-1",
      time: "2026-10-13T07:00:00Z",
      headers: {},
      body: {},
      sender: {},
      repository: "",
    });
  });

  it.each([
    ["not an object", "github"],
    ["no kind", { source: "github", id: "1", time: "t" }],
    ["unknown kind", { source: "github", kind: "push", id: "1", time: "t" }],
    ["no source", { kind: "webhook", id: "1", time: "t" }],
    ["no id", { source: "github", kind: "webhook", time: "t" }],
    ["non-string header", { source: "github", kind: "webhook", id: "1", time: "t", headers: { a: 1 } }],
    ["non-string repository", { source: "github", kind: "webhook", id: "1", time: "t", repository: 3 }],
  ])("rejects %s", (_label, raw) => {
    expect(parseEnvelope(raw)).toHaveProperty("error");
  });
});
