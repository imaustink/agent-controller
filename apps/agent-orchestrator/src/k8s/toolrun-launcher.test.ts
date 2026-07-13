import { describe, expect, it, vi } from "vitest";
import type { JobTemplate } from "../tool-descriptor.js";
import { ToolRunLauncher } from "./toolrun-launcher.js";

const template: JobTemplate = {
  image: "example.com/recipe-scraper:latest",
  namespace: "default",
  serviceAccountName: "recipe-scraper",
  toolRef: "recipe-scraper",
};

describe("ToolRunLauncher", () => {
  it("creates a ToolRun CR referencing the Tool by name, with a callback secretRef (never a plaintext secret)", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new ToolRunLauncher(
      "tool.recipe-agent.dev",
      "v1alpha1",
      { name: "agent-orchestrator-secrets", key: "AGENT_CALLBACK_SECRET" },
      api,
    );

    const launched = await launcher.launch(template, {
      args: ["https://example.com/recipe"],
      callbackUrl: "http://agent-orchestrator-callback.default.svc.cluster.local:8080/callback/abc",
      callbackSecret: "raw-secret-that-must-not-appear-in-the-cr",
    });

    expect(launched.namespace).toBe("default");
    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const [request] = createNamespacedCustomObject.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      group: "tool.recipe-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "toolruns",
    });

    const body = request.body as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      toolRef: "recipe-scraper",
      args: ["https://example.com/recipe"],
      callback: {
        url: "http://agent-orchestrator-callback.default.svc.cluster.local:8080/callback/abc",
        secretRef: { name: "agent-orchestrator-secrets", key: "AGENT_CALLBACK_SECRET" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("raw-secret-that-must-not-appear-in-the-cr");
  });

  it("throws if the template has no toolRef (i.e. was not resolved by CrdToolRegistry)", async () => {
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject: vi.fn() };
    const launcher = new ToolRunLauncher("tool.recipe-agent.dev", "v1alpha1", { name: "s", key: "k" }, api);

    await expect(
      launcher.launch(
        { image: "x", namespace: "default", serviceAccountName: "sa" },
        { callbackUrl: "http://x", callbackSecret: "s" },
      ),
    ).rejects.toThrow(/toolRef/);
  });
});
