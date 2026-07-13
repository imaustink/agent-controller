import { describe, expect, it, vi } from "vitest";
import type { CustomObjectsApiLike } from "../registry/crd-tool-registry.js";
import { CrdAgentRegistry, type AgentCustomResource } from "./crd-agent-registry.js";

const validAgent: AgentCustomResource = {
  metadata: { name: "software-engineering-agent" },
  spec: {
    description: "Performs software-engineering work on GitHub",
    input: "a natural-language coding instruction",
    output: "a PR link and summary",
    allowedRoles: ["writer"],
    tier: "privileged",
    orchestratorPrompt: "Delegate the whole request verbatim as the goal.",
  },
};

describe("CrdAgentRegistry", () => {
  it("maps Agent custom resources to AgentDescriptors", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [validAgent] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdAgentRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const agents = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "agents",
    });
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({
      id: "software-engineering-agent",
      name: "software-engineering-agent",
      allowedRoles: ["writer"],
      tier: "privileged",
      orchestratorPrompt: "Delegate the whole request verbatim as the goal.",
      agentRunTemplate: { namespace: "default", agentRef: "software-engineering-agent" },
    });
    expect(agents[0]?.description).toContain("Performs software-engineering work on GitHub");
  });

  it("skips a malformed Agent (missing description) rather than failing the whole catalog", async () => {
    const malformed: AgentCustomResource = { metadata: { name: "broken" }, spec: { ...validAgent.spec, description: "" } };
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [malformed, validAgent] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdAgentRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    const agents = await registry.listAll();

    expect(agents).toHaveLength(1);
    expect(agents[0]?.id).toBe("software-engineering-agent");
  });

  it("returns an empty catalog when there are zero Agent resources", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdAgentRegistry("default", "core.controller-agent.dev", "v1alpha1", api);

    expect(await registry.listAll()).toEqual([]);
  });
});
