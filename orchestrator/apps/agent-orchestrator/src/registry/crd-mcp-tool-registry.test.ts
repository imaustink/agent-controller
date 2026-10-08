import { describe, expect, it, vi } from "vitest";
import type { WatchCrdFn } from "../k8s/crd-watcher.js";
import type { CustomObjectsApiLike } from "./crd-tool-registry.js";
import {
  CrdMCPToolRegistry,
  toMCPToolDescriptor,
  type MCPToolCustomResource,
} from "./crd-mcp-tool-registry.js";

const createIssue: MCPToolCustomResource = {
  metadata: { name: "mcp:github/create_issue" },
  spec: {
    serverRef: "github",
    remoteToolName: "create_issue",
    description: "Opens a GitHub issue",
    inputSchema: '{"type":"object","properties":{"title":{"type":"string"}}}',
    allowedRoles: ["writer"],
    tier: "standard",
    identityProviders: ["github"],
  },
};

describe("CrdMCPToolRegistry", () => {
  it("maps MCPTool custom resources to ToolDescriptors with an mcpExec spec", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [createIssue] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdMCPToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "mcptools",
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "mcp:github/create_issue",
      name: "mcp:github/create_issue",
      allowedRoles: ["writer"],
      tier: "standard",
      // identityProviders rides the descriptor (not the mcpExec) so the SAME
      // per-user delegation path every other identity-gated tool uses applies.
      identityProviders: ["github"],
      mcpExec: {
        serverRef: "github",
        remoteToolName: "create_issue",
        inputSchema: '{"type":"object","properties":{"title":{"type":"string"}}}',
      },
    });
    // Never a jobTemplate/localExec — mcpExec is the MCPTool discriminator.
    expect(tools[0].jobTemplate).toBeUndefined();
    expect(tools[0].localExec).toBeUndefined();
    // The server's description plus its input schema is what gets embedded.
    expect(tools[0].description).toContain("Opens a GitHub issue");
    expect(tools[0].description).toContain("Input:");
  });

  it("carries the hidden flag through so a hidden exposure stays referenceable-but-not-retrievable (ADR 0008)", () => {
    const descriptor = toMCPToolDescriptor({
      ...createIssue,
      spec: { ...createIssue.spec, hidden: true },
    });
    expect(descriptor?.hidden).toBe(true);
  });

  it("defaults hidden to false and leaves identityProviders undefined when the server needs no per-user token", () => {
    const descriptor = toMCPToolDescriptor({
      metadata: { name: "mcp:weather/forecast" },
      spec: {
        serverRef: "weather",
        remoteToolName: "forecast",
        description: "Public weather",
        allowedRoles: ["reader"],
      },
    });
    expect(descriptor?.hidden).toBe(false);
    expect(descriptor?.identityProviders).toBeUndefined();
    expect(descriptor?.mcpExec?.inputSchema).toBeUndefined();
  });

  it("skips a resource missing serverRef/remoteToolName rather than indexing a tool that can't be proxied", async () => {
    const malformed = { metadata: { name: "broken" }, spec: { ...createIssue.spec, remoteToolName: undefined } };
    const listNamespacedCustomObject = vi
      .fn()
      .mockResolvedValue({ items: [malformed as unknown as MCPToolCustomResource, createIssue] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdMCPToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("mcp:github/create_issue");
  });

  describe("watch", () => {
    it("maps ADDED to an upsert event and DELETED to a delete event", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (opts, cb) => {
        expect(opts.plural).toBe("mcptools");
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdMCPToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api, watchFn);
      const onChange = vi.fn();
      registry.watch(onChange);

      onEvent("ADDED", createIssue);
      expect(onChange).toHaveBeenCalledWith({
        type: "upsert",
        descriptor: expect.objectContaining({ id: "mcp:github/create_issue" }),
      });

      onEvent("DELETED", createIssue);
      expect(onChange).toHaveBeenCalledWith({ type: "delete", id: "mcp:github/create_issue" });
    });

    it("throws when constructed without a watchFn", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      const registry = new CrdMCPToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      expect(() => registry.watch(() => {})).toThrow();
    });
  });
});

describe("toMCPToolDescriptor — approval (ADR 0003)", () => {
  it("round-trips approval (sourced from the MCPServer exposure by the broker) onto the descriptor", () => {
    const d = toMCPToolDescriptor({ ...createIssue, spec: { ...createIssue.spec, approval: "always" } });
    expect(d?.approval).toBe("always");
  });

  it("leaves approval undefined when the MCPTool sets none (existing CRs unaffected)", () => {
    expect(toMCPToolDescriptor(createIssue)?.approval).toBeUndefined();
  });
});
