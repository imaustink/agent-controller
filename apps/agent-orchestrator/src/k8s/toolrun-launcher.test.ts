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
      "core.controller-agent.dev",
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
        url: "http://agent-orchestrator-callback.default.svc.cluster.local:8080/callback/abc",
        secretRef: { name: "agent-orchestrator-secrets", key: "AGENT_CALLBACK_SECRET" },
      },
    });
    expect(JSON.stringify(body)).not.toContain("raw-secret-that-must-not-appear-in-the-cr");
  });

  it("sets the session-id annotation on the ToolRun CR when options.sessionId is given", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new ToolRunLauncher("core.controller-agent.dev", "v1alpha1", { name: "s", key: "k" }, api);

    await launcher.launch(template, {
      args: ["https://example.com/recipe"],
      callbackUrl: "http://x",
      callbackSecret: "s",
      sessionId: "chat-42",
    });

    const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { metadata: Record<string, unknown> } }];
    expect(request.body.metadata.annotations).toEqual({ "controller-agent.dev/session-id": "chat-42" });
  });

  it("omits annotations on the ToolRun CR when no sessionId is given", async () => {
    const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
    const launcher = new ToolRunLauncher("core.controller-agent.dev", "v1alpha1", { name: "s", key: "k" }, api);

    await launcher.launch(template, { args: ["https://example.com/recipe"], callbackUrl: "http://x", callbackSecret: "s" });

    const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { metadata: Record<string, unknown> } }];
    expect(request.body.metadata.annotations).toBeUndefined();
  });

  it("throws if the template has no toolRef (i.e. was not resolved by CrdToolRegistry)", async () => {
    const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject: vi.fn() };
    const launcher = new ToolRunLauncher("core.controller-agent.dev", "v1alpha1", { name: "s", key: "k" }, api);

    await expect(
      launcher.launch(
        { image: "x", namespace: "default", serviceAccountName: "sa" },
        { callbackUrl: "http://x", callbackSecret: "s" },
      ),
    ).rejects.toThrow(/toolRef/);
  });

  describe("per-invocation identity secretEnv (ADR 0028)", () => {
    it("launch() without options.secretEnv never touches the Secret API", async () => {
      const createNamespacedCustomObject = vi.fn().mockResolvedValue({ metadata: { uid: "uid-1" } });
      const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
      const createNamespacedSecret = vi.fn();
      const patchNamespacedSecret = vi.fn();
      const launcher = new ToolRunLauncher(
        "core.controller-agent.dev",
        "v1alpha1",
        { name: "s", key: "k" },
        api,
        { createNamespacedSecret, patchNamespacedSecret },
      );

      await launcher.launch(template, { args: ["issue view 86"], callbackUrl: "http://x", callbackSecret: "s" });

      expect(createNamespacedSecret).not.toHaveBeenCalled();
      expect(patchNamespacedSecret).not.toHaveBeenCalled();
      const [request] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
      expect(request.body.spec.secretEnv).toBeUndefined();
    });

    it("launch() with options.secretEnv creates a Secret, references it from the ToolRun spec, and patches ownerReferences using the created ToolRun's uid", async () => {
      const createNamespacedCustomObject = vi.fn().mockResolvedValue({ metadata: { uid: "toolrun-uid-123" } });
      const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
      const createNamespacedSecret = vi.fn().mockResolvedValue({});
      const patchNamespacedSecret = vi.fn().mockResolvedValue({});
      const launcher = new ToolRunLauncher(
        "core.controller-agent.dev",
        "v1alpha1",
        { name: "s", key: "k" },
        api,
        { createNamespacedSecret, patchNamespacedSecret },
      );

      const launched = await launcher.launch(
        { image: "example.com/github:latest", namespace: "default", serviceAccountName: "github-tool", toolRef: "github" },
        {
          args: ["issue comment 86 --body hi"],
          callbackUrl: "http://x",
          callbackSecret: "s",
          secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_super-secret-value" }],
        },
      );

      expect(launched.namespace).toBe("default");

      expect(createNamespacedSecret).toHaveBeenCalledTimes(1);
      const [secretRequest] = createNamespacedSecret.mock.calls[0] as [
        { namespace: string; body: { metadata: { name: string }; stringData: Record<string, string> } },
      ];
      expect(secretRequest.namespace).toBe("default");
      expect(secretRequest.body.metadata.name).toBe(`${launched.name}-identity`);
      expect(secretRequest.body.stringData).toEqual({ GITHUB_TOKEN: "gho_super-secret-value" });

      const [crRequest] = createNamespacedCustomObject.mock.calls[0] as [{ body: { spec: Record<string, unknown> } }];
      expect(crRequest.body.spec.secretEnv).toEqual([
        { name: "GITHUB_TOKEN", secretRef: { name: `${launched.name}-identity`, key: "GITHUB_TOKEN" } },
      ]);
      // The plaintext token must never appear in the ToolRun CR body.
      expect(JSON.stringify(crRequest.body)).not.toContain("gho_super-secret-value");

      expect(patchNamespacedSecret).toHaveBeenCalledTimes(1);
      const [patchRequest] = patchNamespacedSecret.mock.calls[0] as [{ name: string; namespace: string; body: unknown }];
      expect(patchRequest.name).toBe(`${launched.name}-identity`);
      expect(patchRequest.namespace).toBe("default");
      expect(JSON.stringify(patchRequest.body)).toContain("toolrun-uid-123");
      expect(JSON.stringify(patchRequest.body)).toContain(launched.name);
    });

    it("launch() throws if options.secretEnv is non-empty but no SecretApiLike was configured", async () => {
      const createNamespacedCustomObject = vi.fn().mockResolvedValue({});
      const api = { listNamespacedCustomObject: vi.fn(), createNamespacedCustomObject };
      const launcher = new ToolRunLauncher("core.controller-agent.dev", "v1alpha1", { name: "s", key: "k" }, api);

      await expect(
        launcher.launch(template, {
          args: ["issue view 86"],
          callbackUrl: "http://x",
          callbackSecret: "s",
          secretEnv: [{ name: "GITHUB_TOKEN", value: "gho_x" }],
        }),
      ).rejects.toThrow(/SecretApiLike/);
      expect(createNamespacedCustomObject).not.toHaveBeenCalled();
    });
  });
});
