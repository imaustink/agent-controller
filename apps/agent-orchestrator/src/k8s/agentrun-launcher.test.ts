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

  it("uses a natsSubject callback (no secretRef) when natsUrl is set, so the CR passes controller validation even with an empty callbackSecretRef", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new AgentRunLauncher("core.controller-agent.dev", "v1alpha1", api);

    await launcher.launch(template, "run-3", {
      goal: "add a health check endpoint",
      callbackUrl: "http://unused",
      // Legitimately empty in NATS mode -- config.ts only requires
      // AGENT_CALLBACK_SECRET_REF_NAME when AGENT_NATS_URL is absent.
      callbackSecretRef: { name: "", key: "AGENT_CALLBACK_SECRET" },
      natsUrl: "nats://nats:4222",
      natsSubject: "callbacks.run-3",
    });

    const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
    expect(request.body.spec.callback).toEqual({
      natsSubject: "callbacks.run-3",
      natsUrl: "nats://nats:4222",
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

  it("launch() without options.secretEnv never touches the Secret API", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({ metadata: { uid: "uid-1" } });
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const createNamespacedSecret = vi.fn();
    const patchNamespacedSecret = vi.fn();
    const launcher = new AgentRunLauncher("core.controller-agent.dev", "v1alpha1", api, {
      createNamespacedSecret,
      patchNamespacedSecret,
    });

    await launcher.launch(template, "run-4", {
      goal: "add a health check endpoint",
      callbackUrl: "http://x",
      callbackSecretRef: { name: "s", key: "k" },
    });

    expect(createNamespacedSecret).not.toHaveBeenCalled();
    expect(patchNamespacedSecret).not.toHaveBeenCalled();
    const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
    expect(request.body.spec.secretEnv).toBeUndefined();
  });

  it("launch() with options.secretEnv creates a Secret, references it from the AgentRun spec, and patches ownerReferences using the created AgentRun's uid", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({ metadata: { uid: "agentrun-uid-123" } });
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const createNamespacedSecret = vi.fn().mockResolvedValue({ metadata: { name: "run-5-identity" } });
    const patchNamespacedSecret = vi.fn().mockResolvedValue({});
    const launcher = new AgentRunLauncher("core.controller-agent.dev", "v1alpha1", api, {
      createNamespacedSecret,
      patchNamespacedSecret,
    });

    const launched = await launcher.launch(template, "run-5", {
      goal: "open a PR",
      callbackUrl: "http://x",
      callbackSecretRef: { name: "s", key: "k" },
      secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_super-secret-value" }],
    });

    expect(launched.name).toBe("run-5");

    expect(createNamespacedSecret).toHaveBeenCalledTimes(1);
    const [secretRequest] = createNamespacedSecret.mock.calls[0] as [
      { namespace: string; body: { metadata: { name: string }; stringData: Record<string, string> } },
    ];
    expect(secretRequest.namespace).toBe("default");
    expect(secretRequest.body.metadata.name).toBe("run-5-identity");
    expect(secretRequest.body.stringData).toEqual({ GITHUB_TOKEN: "gho_super-secret-value" });
    // The plaintext token must never appear in the AgentRun CR body.
    expect(JSON.stringify(secretRequest.body)).toContain("gho_super-secret-value");

    const [crRequest] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
    expect(crRequest.body.spec.secretEnv).toEqual([
      { name: "GITHUB_TOKEN", secretRef: { name: "run-5-identity", key: "GITHUB_TOKEN" } },
    ]);
    expect(JSON.stringify(crRequest.body)).not.toContain("gho_super-secret-value");

    expect(patchNamespacedSecret).toHaveBeenCalledTimes(1);
    const [patchRequest] = patchNamespacedSecret.mock.calls[0] as [
      { name: string; namespace: string; body: unknown },
    ];
    expect(patchRequest.name).toBe("run-5-identity");
    expect(patchRequest.namespace).toBe("default");
    expect(JSON.stringify(patchRequest.body)).toContain("agentrun-uid-123");
    expect(JSON.stringify(patchRequest.body)).toContain("run-5");
  });

  it("launch() throws if options.secretEnv is non-empty but no SecretApiLike was configured", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new AgentRunLauncher("core.controller-agent.dev", "v1alpha1", api);

    await expect(
      launcher.launch(template, "run-6", {
        goal: "open a PR",
        callbackUrl: "http://x",
        callbackSecretRef: { name: "s", key: "k" },
        secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_x" }],
      }),
    ).rejects.toThrow(/SecretApiLike/);
    expect(createNamespacedCustomObject).not.toHaveBeenCalled();
  });
});
