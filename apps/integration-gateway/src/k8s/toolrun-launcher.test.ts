import { describe, expect, it, vi } from "vitest";
import type { JobTemplate } from "../registry/types.js";
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
    const launcher = new ToolRunLauncher(
      "core.controller-agent.dev",
      "v1alpha1",
      { name: "integration-gateway-secrets", key: "secret" },
      { createNamespacedCustomObject },
    );

    const launched = await launcher.launch(template, {
      args: ["https://example.com/recipe"],
      callbackUrl: "http://integration-gateway-callback.default.svc.cluster.local:8091/callback/abc",
    });

    expect(launched.namespace).toBe("default");
    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const [request] = createNamespacedCustomObject.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "toolruns",
    });

    const body = request.body as { spec: Record<string, unknown> };
    expect(body.spec).toEqual({
      toolRef: "recipe-scraper",
      args: ["https://example.com/recipe"],
      callback: {
        url: "http://integration-gateway-callback.default.svc.cluster.local:8091/callback/abc",
        secretRef: { name: "integration-gateway-secrets", key: "secret" },
      },
    });
  });

  it("throws if the template has no toolRef", async () => {
    const launcher = new ToolRunLauncher(
      "core.controller-agent.dev",
      "v1alpha1",
      { name: "s", key: "k" },
      { createNamespacedCustomObject: vi.fn() },
    );

    await expect(
      launcher.launch({ image: "x", namespace: "default", serviceAccountName: "sa" }, { callbackUrl: "http://x" }),
    ).rejects.toThrow(/toolRef/);
  });
});
