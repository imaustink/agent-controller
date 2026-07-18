import { describe, expect, it, vi } from "vitest";
import {
  AGENT_PLURAL,
  CrdCatalogRegistry,
  TOOL_PLURAL,
  type AgentCustomResource,
  type CustomObjectsApiLike,
  type ToolCustomResource,
} from "./crd-catalog-registry.js";

const imageTool: ToolCustomResource = {
  metadata: { name: "recipe-scraper" },
  spec: {
    description: "Extracts a recipe from a URL",
    input: "a URL",
    output: "a recipe envelope",
    allowedRoles: ["reader"],
    image: "example.com/recipe-scraper:latest",
    serviceAccountName: "recipe-scraper",
    args: ["--flag"],
    env: [{ name: "FOO", value: "bar" }],
    resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
  },
};

const agentBackedTool: ToolCustomResource = {
  metadata: { name: "opencode-swe-tool" },
  spec: {
    description: "Delegates to an agent",
    input: "a goal",
    output: "a final reply",
    allowedRoles: ["writer"],
    agentRef: "opencode-swe-agent",
  },
};

const agent: AgentCustomResource = {
  metadata: { name: "software-engineering-agent" },
  spec: {
    description: "Performs software-engineering work",
    input: "a coding task",
    output: "a final reply",
    allowedRoles: ["writer"],
  },
};

describe("CrdCatalogRegistry", () => {
  it("maps an image-based Tool custom resource to a CatalogEntry", async () => {
    const getNamespacedCustomObject = vi.fn().mockResolvedValue(imageTool);
    const api: CustomObjectsApiLike = { getNamespacedCustomObject };
    const registry = new CrdCatalogRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const entry = await registry.getById("recipe-scraper");

    expect(getNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: TOOL_PLURAL,
      name: "recipe-scraper",
    });
    expect(entry).toMatchObject({
      kind: "tool",
      id: "recipe-scraper",
      allowedRoles: ["reader"],
      jobTemplate: {
        image: "example.com/recipe-scraper:latest",
        namespace: "default",
        serviceAccountName: "recipe-scraper",
        args: ["--flag"],
        env: { FOO: "bar" },
        toolRef: "recipe-scraper",
        resources: { requests: { cpu: "100m", memory: "128Mi" }, limits: { cpu: "500m", memory: "512Mi" } },
      },
    });
  });

  it("maps an agent-backed Tool custom resource to a CatalogEntry", async () => {
    const getNamespacedCustomObject = vi.fn().mockResolvedValue(agentBackedTool);
    const api: CustomObjectsApiLike = { getNamespacedCustomObject };
    const registry = new CrdCatalogRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const entry = await registry.getById("opencode-swe-tool");

    expect(entry).toEqual({
      kind: "tool",
      id: "opencode-swe-tool",
      allowedRoles: ["writer"],
      agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
    });
  });

  it("maps an Agent custom resource to a CatalogEntry when no Tool with that id exists", async () => {
    const getNamespacedCustomObject = vi
      .fn()
      .mockRejectedValueOnce({ statusCode: 404 })
      .mockResolvedValueOnce(agent);
    const api: CustomObjectsApiLike = { getNamespacedCustomObject };
    const registry = new CrdCatalogRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const entry = await registry.getById("software-engineering-agent");

    expect(getNamespacedCustomObject).toHaveBeenNthCalledWith(1, {
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: TOOL_PLURAL,
      name: "software-engineering-agent",
    });
    expect(getNamespacedCustomObject).toHaveBeenNthCalledWith(2, {
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: AGENT_PLURAL,
      name: "software-engineering-agent",
    });
    expect(entry).toEqual({
      kind: "agent",
      id: "software-engineering-agent",
      allowedRoles: ["writer"],
      agentRunTemplate: { namespace: "default", agentRef: "software-engineering-agent" },
    });
  });

  it("returns undefined when neither the Tool nor Agent resource exists", async () => {
    const getNamespacedCustomObject = vi.fn().mockRejectedValue({ statusCode: 404 });
    const api: CustomObjectsApiLike = { getNamespacedCustomObject };
    const registry = new CrdCatalogRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    await expect(registry.getById("missing")).resolves.toBeUndefined();
    expect(getNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });
});
