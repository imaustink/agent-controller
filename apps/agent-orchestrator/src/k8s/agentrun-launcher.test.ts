import { describe, expect, it, vi } from "vitest";
import type { AgentRunTemplate } from "../agents/types.js";
import { AgentRunLauncher } from "./agentrun-launcher.js";

const template: AgentRunTemplate = { namespace: "default", agentRef: "software-engineering-agent" };

describe("AgentRunLauncher", () => {
  it("creates an AgentRun CR referencing the Agent by name, with the goal and a callback secretRef", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new AgentRunLauncher("core.controller-agent.dev", "v1alpha1", api);

    const launched = await launcher.launch(template, "run-1", {
      goal: "add a health check endpoint",
      callbackUrl: "http://agent-orchestrator-callback.default.svc.cluster.local:8080/callback/abc",
      callbackSecretRef: { name: "agent-orchestrator-secrets", key: "AGENT_CALLBACK_SECRET" },
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
        url: "http://agent-orchestrator-callback.default.svc.cluster.local:8080/callback/abc",
        secretRef: { name: "agent-orchestrator-secrets", key: "AGENT_CALLBACK_SECRET" },
      },
      timeoutSeconds: 1800,
    });
  });

  it("omits timeoutSeconds when not provided (controller default applies)", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new AgentRunLauncher("core.controller-agent.dev", "v1alpha1", api);

    await launcher.launch(template, "run-2", {
      goal: "add a health check endpoint",
      callbackUrl: "http://x",
      callbackSecretRef: { name: "s", key: "k" },
    });

    const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
    expect(request.body.spec.timeoutSeconds).toBeUndefined();
  });
});
