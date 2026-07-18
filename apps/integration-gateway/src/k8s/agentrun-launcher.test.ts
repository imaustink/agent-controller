import { describe, expect, it, vi } from "vitest";
import type { AgentRunTemplate } from "../registry/types.js";
import { AgentRunLauncher } from "./agentrun-launcher.js";

const template: AgentRunTemplate = { namespace: "default", agentRef: "software-engineering-agent" };

describe("AgentRunLauncher", () => {
  it("creates an AgentRun CR referencing the Agent by name, with the goal and a callback secretRef", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const launcher = new AgentRunLauncher(
      "core.controller-agent.dev",
      "v1alpha1",
      { name: "integration-gateway-secrets", key: "secret" },
      { createNamespacedCustomObject },
    );

    const launched = await launcher.launch(template, "run-1", {
      goal: "add a health check endpoint",
      callbackUrl: "http://integration-gateway-callback.default.svc.cluster.local:8091/callback/abc",
      timeoutSeconds: 1800,
    });

    expect(launched.namespace).toBe("default");
    expect(launched.name).toBe("run-1");
    expect(createNamespacedCustomObject).toHaveBeenCalledTimes(1);
    const [request] = createNamespacedCustomObject.mock.calls[0] as [Record<string, unknown>];
    expect(request).toMatchObject({
      group: "core.controller-agent.dev",
      version: "v1alpha1",
      namespace: "default",
      plural: "agentruns",
    });

    const body = request.body as { metadata: { name: string }; spec: Record<string, unknown> };
    expect(body.metadata.name).toBe("run-1");
    expect(body.spec).toEqual({
      agentRef: "software-engineering-agent",
      goal: "add a health check endpoint",
      callback: {
        url: "http://integration-gateway-callback.default.svc.cluster.local:8091/callback/abc",
        secretRef: { name: "integration-gateway-secrets", key: "secret" },
      },
      timeoutSeconds: 1800,
    });
  });

  it("omits timeoutSeconds when not provided", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const launcher = new AgentRunLauncher(
      "core.controller-agent.dev",
      "v1alpha1",
      { name: "integration-gateway-secrets", key: "secret" },
      { createNamespacedCustomObject },
    );

    await launcher.launch(template, "run-2", {
      goal: "add a health check endpoint",
      callbackUrl: "http://x",
    });

    const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
    expect(request.body.spec.timeoutSeconds).toBeUndefined();
  });
});
