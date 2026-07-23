import { describe, expect, it, vi } from "vitest";
import type { Event } from "@controller-agent/messaging";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { JobResultReceiver } from "../callback/receiver.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { AgentDescriptor } from "../agents/types.js";
import type { AgentOrchestratorChannel } from "../agents/nats-agent-channel.js";
import { dispatchResolvedTool, makeSubAgentToolCallHandler, type ToolDispatchDeps } from "./dispatch-tool.js";

const containerTool: ToolDescriptor = {
  id: "kubectl-readonly",
  name: "kubectl-readonly",
  description: "Runs a read-only kubectl command.",
  allowedRoles: ["reader"],
  jobTemplate: { image: "example.com/kubectl-readonly:latest", namespace: "default", serviceAccountName: "kubectl-readonly-sa" },
};

const localTool: ToolDescriptor = {
  id: "web-fetch",
  name: "web-fetch",
  description: "Fetches a URL.",
  allowedRoles: ["reader"],
  localExec: { runtime: "node", package: "web-fetch", version: "1.0.0", network: true },
};

const agentBackedTool: ToolDescriptor = {
  id: "opencode-swe-agent-tool",
  name: "opencode-swe-agent-tool",
  description: "Delegates a coding task.",
  allowedRoles: ["writer"],
  agentRunTemplate: { namespace: "default", agentRef: "opencode-swe-agent" },
};

function fakeContainerToolLauncher(): ContainerToolLauncher {
  return { launch: vi.fn().mockResolvedValue({ jobId: "job-1" }) };
}

function fakeJobResultReceiver(event: Event): JobResultReceiver {
  return {
    awaitJob: vi.fn().mockResolvedValue(event),
    onJobProgress: vi.fn().mockReturnValue(() => undefined),
  };
}

describe("dispatchResolvedTool", () => {
  it("rejects an agent-backed tool with a clean error (v1 scope cut)", async () => {
    const outcome = await dispatchResolvedTool(agentBackedTool, "do the thing", {
      containerToolLauncher: fakeContainerToolLauncher(),
      jobResultReceiver: fakeJobResultReceiver({ type: "succeeded", job_id: "j", result: "x" }),
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("agent-backed") });
  });

  it("dispatches a LocalTool via localToolExecutor and returns its result", async () => {
    const localToolExecutor: LocalToolExecutor = {
      run: vi.fn().mockResolvedValue({ type: "succeeded", job_id: "j", result: { fetched: true } }),
    } as unknown as LocalToolExecutor;

    const outcome = await dispatchResolvedTool(localTool, "https://example.com", {
      containerToolLauncher: fakeContainerToolLauncher(),
      jobResultReceiver: fakeJobResultReceiver({ type: "succeeded", job_id: "j", result: "unused" }),
      localToolExecutor,
    });

    expect(outcome).toEqual({ ok: true, result: { fetched: true } });
    expect(localToolExecutor.run).toHaveBeenCalledWith(localTool, "https://example.com", undefined);
  });

  it("reports a LocalTool as unconfigured when no executor is provided", async () => {
    const outcome = await dispatchResolvedTool(localTool, "https://example.com", {
      containerToolLauncher: fakeContainerToolLauncher(),
      jobResultReceiver: fakeJobResultReceiver({ type: "succeeded", job_id: "j", result: "x" }),
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("local execution is not configured") });
  });

  it("dispatches a container tool via NATS mode and returns the succeeded event's result", async () => {
    const containerToolLauncher = fakeContainerToolLauncher();
    const jobResultReceiver = fakeJobResultReceiver({ type: "succeeded", job_id: "job-1", result: { pods: ["a"] } });

    const outcome = await dispatchResolvedTool(containerTool, "get pods -n default", {
      containerToolLauncher,
      jobResultReceiver,
      natsUrl: "nats://nats:4222",
    });

    expect(outcome).toEqual({ ok: true, result: { pods: ["a"] } });
    expect(containerToolLauncher.launch).toHaveBeenCalledWith(
      containerTool.jobTemplate,
      expect.objectContaining({ args: ["get pods -n default"], natsUrl: "nats://nats:4222" }),
    );
  });

  it("dispatches a container tool via HTTP callback mode when natsUrl is absent", async () => {
    const containerToolLauncher = fakeContainerToolLauncher();
    const jobResultReceiver = fakeJobResultReceiver({ type: "succeeded", job_id: "job-1", result: "ok" });

    const outcome = await dispatchResolvedTool(containerTool, "get pods", {
      containerToolLauncher,
      jobResultReceiver,
      callbackBaseUrl: "https://callback.example.com",
      callbackSecret: "shh",
    });

    expect(outcome).toEqual({ ok: true, result: "ok" });
    expect(containerToolLauncher.launch).toHaveBeenCalledWith(
      containerTool.jobTemplate,
      expect.objectContaining({ callbackSecret: "shh" }),
    );
  });

  it("reports a container tool's failed event as ok: false", async () => {
    const outcome = await dispatchResolvedTool(containerTool, "get pods", {
      containerToolLauncher: fakeContainerToolLauncher(),
      jobResultReceiver: fakeJobResultReceiver({ type: "failed", job_id: "job-1", code: "boom", message: "kubectl exited 1" }),
      natsUrl: "nats://nats:4222",
    });
    expect(outcome).toEqual({ ok: false, error: expect.stringContaining("kubectl exited 1") });
  });
});

describe("makeSubAgentToolCallHandler", () => {
  const agent: AgentDescriptor = {
    id: "generic-agent",
    name: "generic-agent",
    description: "A generic sub-agent.",
    allowedRoles: ["reader"],
    toolRefs: ["kubectl-readonly"],
    agentRunTemplate: { namespace: "default", agentRef: "generic-agent" },
  };

  function fakeChannel(): AgentOrchestratorChannel & { resolveToolCall: ReturnType<typeof vi.fn> } {
    return {
      awaitReply: vi.fn(),
      sendPrompt: vi.fn(),
      resolveToolCall: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
    };
  }

  const baseDeps: ToolDispatchDeps = {
    containerToolLauncher: fakeContainerToolLauncher(),
    jobResultReceiver: fakeJobResultReceiver({ type: "succeeded", job_id: "job-1", result: { ok: true } }),
    natsUrl: "nats://nats:4222",
  };

  it("resolves with an error when the tool isn't declared in the agent's toolRefs", async () => {
    const channel = fakeChannel();
    const handler = makeSubAgentToolCallHandler("run-1", agent, channel, { getById: () => containerTool }, baseDeps);

    handler({ callId: "call-1", tool: "web-fetch", input: "x" });
    await new Promise((r) => setTimeout(r, 0));

    expect(channel.resolveToolCall).toHaveBeenCalledWith("run-1", "call-1", {
      ok: false,
      error: expect.stringContaining("not declared"),
    });
  });

  it("resolves with an error when the declared tool isn't found in the catalog", async () => {
    const channel = fakeChannel();
    const handler = makeSubAgentToolCallHandler("run-1", agent, channel, { getById: () => undefined }, baseDeps);

    handler({ callId: "call-1", tool: "kubectl-readonly", input: "get pods" });
    await new Promise((r) => setTimeout(r, 0));

    expect(channel.resolveToolCall).toHaveBeenCalledWith("run-1", "call-1", {
      ok: false,
      error: expect.stringContaining("not found in the catalog"),
    });
  });

  it("dispatches an allowed, resolvable tool and reports success", async () => {
    const channel = fakeChannel();
    const handler = makeSubAgentToolCallHandler("run-1", agent, channel, { getById: () => containerTool }, baseDeps);

    handler({ callId: "call-1", tool: "kubectl-readonly", input: "get pods -n default" });
    await new Promise((r) => setTimeout(r, 0));

    expect(channel.resolveToolCall).toHaveBeenCalledWith("run-1", "call-1", { ok: true, result: { ok: true } });
  });

  it("does nothing when the channel has no resolveToolCall (fake/test channel)", async () => {
    const channel: AgentOrchestratorChannel = { awaitReply: vi.fn(), sendPrompt: vi.fn(), close: vi.fn() };
    const handler = makeSubAgentToolCallHandler("run-1", agent, channel, { getById: () => containerTool }, baseDeps);

    expect(() => handler({ callId: "call-1", tool: "kubectl-readonly", input: "get pods" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
