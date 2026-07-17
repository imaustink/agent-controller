import { describe, expect, it, vi } from "vitest";
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

  it("returns an empty catalog when there are zero Tool resources", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdToolRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    expect(await registry.listAll()).toEqual([]);
  });
});
