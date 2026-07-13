import { describe, expect, it, vi } from "vitest";
import type { CustomObjectsApiLike } from "./crd-tool-registry.js";
import {
  CrdLocalToolRegistry,
  toLocalToolDescriptor,
  type LocalToolCustomResource,
} from "./crd-local-tool-registry.js";

const nodeTool: LocalToolCustomResource = {
  metadata: { name: "http-get-node" },
  spec: {
    description: "Fetches a URL",
    input: "a URL on stdin",
    output: "a JSON envelope",
    allowedRoles: ["reader"],
    tier: "standard",
    runtime: "node",
    package: "@recipe-agent/http-get",
    version: "1.0.0",
    env: [{ name: "FOO", value: "bar" }],
    secretEnv: [{ name: "TOKEN", secretRef: { name: "s", key: "k" } }],
    network: true,
    timeoutSeconds: 15,
    resources: { requests: { cpu: "50m", memory: "64Mi" } },
  },
};

const shellTool: LocalToolCustomResource = {
  metadata: { name: "http-get-shell" },
  spec: {
    description: "Fetches a URL via curl",
    input: "a URL on stdin",
    output: "a JSON envelope",
    allowedRoles: ["reader"],
    runtime: "shell",
    sourceURL: "https://example.com/http-get.sh",
    checksum: "0".repeat(64),
    network: true,
  },
};

describe("CrdLocalToolRegistry", () => {
  it("maps LocalTool custom resources to ToolDescriptors with a localExec spec", async () => {
    const listNamespacedCustomObject = vi.fn().mockResolvedValue({ items: [nodeTool] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdLocalToolRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(listNamespacedCustomObject).toHaveBeenCalledWith({
      group: "tool.recipe-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "localtools",
    });
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      id: "http-get-node",
      name: "http-get-node",
      allowedRoles: ["reader"],
      tier: "standard",
      localExec: {
        runtime: "node",
        package: "@recipe-agent/http-get",
        version: "1.0.0",
        env: { FOO: "bar" },
        secretEnv: [{ name: "TOKEN", secretRef: { name: "s", key: "k" } }],
        network: true,
        timeoutSeconds: 15,
        resources: { requests: { cpu: "50m", memory: "64Mi" } },
      },
    });
    // Never a jobTemplate — this is the LocalTool discriminator.
    expect(tools[0].jobTemplate).toBeUndefined();
    expect(tools[0].description).toContain("Fetches a URL");
  });

  it("maps a shell LocalTool (sourceURL + checksum, no package)", () => {
    const descriptor = toLocalToolDescriptor(shellTool);
    expect(descriptor?.localExec).toMatchObject({
      runtime: "shell",
      sourceUrl: "https://example.com/http-get.sh",
      checksum: "0".repeat(64),
      network: true,
    });
    expect(descriptor?.localExec?.package).toBeUndefined();
  });

  it("defaults network to false when omitted", () => {
    const descriptor = toLocalToolDescriptor({
      metadata: { name: "pure" },
      spec: {
        description: "d",
        input: "i",
        output: "o",
        allowedRoles: ["reader"],
        runtime: "python",
        package: "pure-tool",
        version: "2.0.0",
      },
    });
    expect(descriptor?.localExec?.network).toBe(false);
  });

  it("skips a resource with no runtime rather than failing the whole catalog", async () => {
    const malformed = { metadata: { name: "broken" }, spec: { ...nodeTool.spec, runtime: undefined } };
    const listNamespacedCustomObject = vi
      .fn()
      .mockResolvedValue({ items: [malformed as unknown as LocalToolCustomResource, nodeTool] });
    const api: CustomObjectsApiLike = { listNamespacedCustomObject };
    const registry = new CrdLocalToolRegistry("default", "tool.recipe-agent.dev", "v1alpha1", api);

    const tools = await registry.listAll();

    expect(tools).toHaveLength(1);
    expect(tools[0].id).toBe("http-get-node");
  });
});
