import { describe, expect, it, vi } from "vitest";
import type { WatchCrdFn } from "../k8s/crd-watcher.js";
import { CrdToolRegistry, type CustomObjectsApiLike, type ToolCustomResource } from "./crd-tool-registry.js";

const validTool: ToolCustomResource = {
  metadata: { name: "recipe-scraper" },
  spec: {
    description: "Extracts a recipe from a URL",
    input: "a URL",
    output: "a recipe JSON envelope",
    allowedRoles: ["reader"],
    tier: "standard",
    image: "example.com/recipe-scraper:latest",
    serviceAccountName: "recipe-scraper",
    args: ["--foo"],
    env: [{ name: "FOO", value: "bar" }],
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
  },
};

describe("CrdToolRegistry", () => {
  it("maps Tool custom resources to ToolDescriptors", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [validTool] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "tools",
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "recipe-scraper",
      name: "recipe-scraper",
      allowedRoles: ["reader"],
      tier: "standard",
      jobTemplate: {
        image: "example.com/recipe-scraper:latest",
        namespace: "default",
        serviceAccountName: "recipe-scraper",
        args: ["--foo"],
        env: { FOO: "bar" },
        toolRef: "recipe-scraper",
        resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
      },
    });
    expect(tools[0].description).toContain("Extracts a recipe from a URL");
  });

  it("skips a malformed Tool (missing image/serviceAccountName) rather than failing the whole catalog", async () => {
    const malformed: ToolCustomResource = {
      metadata: { name: "broken-tool" },
      spec: { ...validTool.spec, image: "", serviceAccountName: "" },
    };
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [malformed, validTool] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("recipe-scraper");
  });

  it("maps an agent-backed Tool (agentRef) to a ToolDescriptor with agentRunTemplate", async () => {
    const agentBacked: ToolCustomResource = {
      metadata: { name: "opencode-swe-agent-tool" },
      spec: {
        description: "Delegates to the opencode SWE agent",
        input: "a goal",
        output: "a final reply",
        allowedRoles: ["writer"],
        agentRef: "opencode-swe-agent",
      },
    };
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [agentBacked] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "opencode-swe-agent-tool",
      name: "opencode-swe-agent-tool",
      allowedRoles: ["writer"],
      agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
    });
    expect(tools[0].jobTemplate).toBeUndefined();
  });

  it("carries Tool.spec.identityProviders through to the ToolDescriptor for a container Tool (ADR 0027, e.g. the github Tool)", async () => {
    const identityLinked: ToolCustomResource = {
      metadata: { name: "github" },
      spec: {
        description: "Runs a gh CLI command against GitHub",
        input: "a gh CLI command line",
        output: "gh's own output",
        allowedRoles: ["writer"],
        image: "example.com/github:latest",
        serviceAccountName: "github-tool",
        identityProviders: ["github"],
      },
    };
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [identityLinked] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0]!.identityProviders).toEqual(["github"]);
  });

  it("omits identityProviders when the Tool CR does not declare any", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [validTool] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(tools[0]!.identityProviders).toBeUndefined();
  });

  it("returns an empty catalog when there are zero Tool resources", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    expect(await registry.listAll()).toEqual([]);
  });

  describe("watch", () => {
    it("throws when constructed without a watchFn", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);
      expect(() => registry.watch(() => {})).toThrow();
    });

    it("maps ADDED/MODIFIED to upsert events with the decoded descriptor", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (opts, cb) => {
        expect(opts).toEqual({ group: "core.controller-agent.dev", version: "v1alpha1", namespace: "default", plural: "tools" });
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api, watchFn);
      const onChange = vi.fn();
      registry.watch(onChange);

      onEvent("ADDED", validTool);

      expect(onChange).toHaveBeenCalledWith({
        type: "upsert",
        descriptor: expect.objectContaining({ id: "recipe-scraper" }),
      });
    });

    it("maps DELETED to a delete event carrying just the id", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (_opts, cb) => {
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api, watchFn);
      const onChange = vi.fn();
      registry.watch(onChange);

      onEvent("DELETED", { metadata: { name: "recipe-scraper" }, spec: {} });

      expect(onChange).toHaveBeenCalledWith({ type: "delete", id: "recipe-scraper" });
    });

    it("skips an event with no metadata.name rather than throwing", () => {
      const api: CustomObjectsApiLike = { listNamespacedCustomObject: vi.fn() };
      let onEvent!: (phase: string, obj: unknown) => void;
      const watchFn: WatchCrdFn = (_opts, cb) => {
        onEvent = cb;
        return { stop: vi.fn() };
      };
      const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api, watchFn);
      const onChange = vi.fn();
      registry.watch(onChange);

      onEvent("ADDED", {});

      expect(onChange).not.toHaveBeenCalled();
    });
  });
});
