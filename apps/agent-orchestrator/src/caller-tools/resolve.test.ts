import { describe, expect, it, vi } from "vitest";
import { makeCallerTool } from "./parse.js";
import { resolveCallerTools, toCallerToolDescriptor } from "./resolve.js";
import type { CallerToolStore } from "./types.js";

const tools = Array.from({ length: 8 }, (_, i) => makeCallerTool(`tool_${i}`, `does thing ${i}`, { type: "object" }));

function fakeStore(overrides: Partial<CallerToolStore> = {}): CallerToolStore & {
  index: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  return {
    index: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
    prune: vi.fn().mockResolvedValue(0),
    ...overrides,
  } as CallerToolStore & { index: ReturnType<typeof vi.fn>; search: ReturnType<typeof vi.fn> };
}

describe("resolveCallerTools", () => {
  it("skips the store entirely when the caller sent no more tools than topK", async () => {
    // The cost argument for JIT vectorization (docs/adr/0035 §3): with nothing
    // to prune, an embedding + Qdrant round trip would be pure added latency on
    // the hot path, so the common case must not touch the store at all.
    const store = fakeStore();
    const five = tools.slice(0, 5);

    expect(await resolveCallerTools("q", five, { kind: "auto" }, 5, store)).toEqual(five);
    expect(store.index).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
  });

  it("indexes and ranks when the caller sent more tools than topK", async () => {
    const ranked = [tools[3]!, tools[6]!];
    const store = fakeStore({ search: vi.fn().mockResolvedValue(ranked) });

    expect(await resolveCallerTools("find me thing 3", tools, { kind: "auto" }, 2, store)).toEqual(ranked);
    expect(store.index).toHaveBeenCalledWith(tools);
    expect(store.search).toHaveBeenCalledWith("find me thing 3", tools, 2);
  });

  it("drops every caller tool on tool_choice: none", async () => {
    const store = fakeStore();
    expect(await resolveCallerTools("q", tools, { kind: "none" }, 2, store)).toEqual([]);
    expect(store.index).not.toHaveBeenCalled();
  });

  it("offers only the named tool on a specific tool_choice, bypassing retrieval", async () => {
    // Ranking one candidate against itself is overhead, and offering the others
    // would contradict the caller's explicit instruction.
    const store = fakeStore();
    expect(await resolveCallerTools("q", tools, { kind: "function", name: "tool_5" }, 2, store)).toEqual([tools[5]!]);
    expect(store.search).not.toHaveBeenCalled();
  });

  it("truncates rather than dropping the feature when no store is configured", async () => {
    const onWarn = vi.fn();
    const resolved = await resolveCallerTools("q", tools, { kind: "auto" }, 3, undefined, onWarn);
    expect(resolved).toEqual(tools.slice(0, 3));
    expect(onWarn).toHaveBeenCalled();
  });

  it("truncates rather than failing the turn when retrieval throws", async () => {
    const store = fakeStore({ search: vi.fn().mockRejectedValue(new Error("qdrant down")) });
    const onWarn = vi.fn();

    expect(await resolveCallerTools("q", tools, { kind: "auto" }, 3, store, onWarn)).toEqual(tools.slice(0, 3));
    expect(onWarn).toHaveBeenCalledWith(expect.stringContaining("retrieval failed"), expect.any(Error));
  });

  it("falls back to truncation when a healthy store returns nothing", async () => {
    // "Caller offered 8 tools and none were even considered" is the worse
    // failure of the two.
    const store = fakeStore({ search: vi.fn().mockResolvedValue([]) });
    expect(await resolveCallerTools("q", tools, { kind: "auto" }, 3, store)).toEqual(tools.slice(0, 3));
  });

  it("returns nothing for an empty tool list", async () => {
    expect(await resolveCallerTools("q", [], { kind: "auto" }, 5, fakeStore())).toEqual([]);
  });
});

describe("toCallerToolDescriptor", () => {
  it("namespaces the id so it can never collide with a catalog Tool", async () => {
    const descriptor = toCallerToolDescriptor(tools[0]!);
    expect(descriptor.id).toBe("caller:tool_0");
    expect(descriptor.name).toBe("tool_0");
    expect(descriptor.callerTool).toBe(tools[0]!);
  });

  it("carries no roles and no executable template", () => {
    // Empty roles because caller tools are never retrieved through the
    // RBAC-filtered VectorStore -- and empty is the fail-closed value everywhere
    // else, so a future path that DID filter these would hide them rather than
    // expose them (docs/adr/0035 §2).
    const descriptor = toCallerToolDescriptor(tools[0]!);
    expect(descriptor.allowedRoles).toEqual([]);
    expect(descriptor.jobTemplate).toBeUndefined();
    expect(descriptor.localExec).toBeUndefined();
    expect(descriptor.agentRunTemplate).toBeUndefined();
  });
});
