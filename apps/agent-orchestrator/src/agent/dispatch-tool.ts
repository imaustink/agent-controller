import { randomUUID } from "node:crypto";
import type { Event } from "@controller-agent/messaging";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { JobResultReceiver } from "../callback/receiver.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { AgentDescriptor } from "../agents/types.js";
import type { AgentOrchestratorChannel } from "../agents/nats-agent-channel.js";

/** Outcome of dispatching one resolved Tool, reported back as a `tool_result` down-message (docs/adr/0028). */
export type ToolCallOutcome = { ok: true; result?: unknown } | { ok: false; error: string };

/** The subset of `AgentGraphDeps` {@link dispatchResolvedTool} needs to run a container/LocalTool. */
export interface ToolDispatchDeps {
  containerToolLauncher: ContainerToolLauncher;
  jobResultReceiver: JobResultReceiver;
  localToolExecutor?: LocalToolExecutor;
  natsUrl?: string;
  callbackBaseUrl?: string;
  callbackSecret?: string;
}

/**
 * Runs a resolved {@link ToolDescriptor} to completion and reports the
 * outcome — the sub-agent-tool-call counterpart of `runTool`'s container/
 * LocalTool branch (`agent/graph.ts`), extracted standalone rather than
 * refactoring that node in place (docs/adr/0028: avoids touching a node with
 * substantial existing continuation-token/actionHistory test coverage that a
 * raw sub-agent tool call has no use for).
 *
 * v1 scope cut: an agent-backed Tool (`tool.agentRunTemplate`) returns a
 * clean `{ok:false}` rather than recursively launching another AgentRun —
 * see docs/adr/0028's "v1 scope cut" section.
 */
export async function dispatchResolvedTool(
  tool: ToolDescriptor,
  input: string,
  deps: ToolDispatchDeps,
  opts: { sessionId?: string } = {},
): Promise<ToolCallOutcome> {
  if (tool.agentRunTemplate) {
    return {
      ok: false,
      error: `tool ${tool.id} is agent-backed -- calling an agent-backed tool from a sub-agent's own toolRefs is not supported yet`,
    };
  }

  let event: Event;
  if (tool.localExec) {
    if (!deps.localToolExecutor) {
      return { ok: false, error: `tool ${tool.id} is a LocalTool but local execution is not configured` };
    }
    event = await deps.localToolExecutor.run(tool, input, opts.sessionId);
  } else if (tool.jobTemplate) {
    const jobId = randomUUID();
    const awaitResult = deps.jobResultReceiver.awaitJob(jobId);
    if (deps.natsUrl) {
      await deps.containerToolLauncher.launch(tool.jobTemplate, {
        args: [input],
        natsUrl: deps.natsUrl,
        natsSubject: `callbacks.${jobId}`,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      });
    } else {
      if (!deps.callbackBaseUrl || !deps.callbackSecret) {
        return { ok: false, error: `tool ${tool.id} requires callbackBaseUrl/callbackSecret (HTTP callback mode) but neither is configured` };
      }
      const callbackUrl = `${deps.callbackBaseUrl}/callback/${jobId}`;
      await deps.containerToolLauncher.launch(tool.jobTemplate, {
        args: [input],
        callbackUrl,
        callbackSecret: deps.callbackSecret,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      });
    }
    event = await awaitResult;
  } else {
    return { ok: false, error: `tool ${tool.id} has neither a jobTemplate, localExec, nor agentRunTemplate spec` };
  }

  if (event.type === "failed") {
    return { ok: false, error: `tool failed (${event.code}): ${event.message}` };
  }
  if (event.type !== "succeeded") {
    return { ok: true, result: undefined };
  }
  return { ok: true, result: event.result };
}

/** Direct (non-RAG) lookup of the full tool catalog by id (docs/adr/0028) -- see `AgentGraphDeps.toolCatalog`'s doc comment for why this bypasses the RBAC-filtered VectorStore. */
export interface ToolCatalog {
  getById(id: string): ToolDescriptor | undefined;
}

/**
 * Builds the `onToolCall` handler passed to `AgentOrchestratorChannel.awaitReply`
 * for a specific live AgentRun (docs/adr/0028): validates the requested tool
 * name against `agent.toolRefs`, resolves it via `toolCatalog`, dispatches it,
 * and reports the outcome back via `channel.resolveToolCall`. Never throws --
 * every failure mode (undeclared tool, unresolvable id, dispatch error)
 * becomes a `{ok:false}` tool_result instead, since the caller (the sub-agent
 * process) is waiting on a reply either way.
 */
export function makeSubAgentToolCallHandler(
  runId: string,
  agent: AgentDescriptor,
  channel: AgentOrchestratorChannel,
  toolCatalog: ToolCatalog | undefined,
  toolDeps: ToolDispatchDeps,
  opts: { sessionId?: string } = {},
): (call: { callId: string; tool: string; input: string }) => void {
  return (call) => {
    void (async () => {
      if (!channel.resolveToolCall) return; // channel doesn't support tool calls (e.g. a test fake) -- nothing to reply with
      if (!agent.toolRefs?.includes(call.tool)) {
        await channel.resolveToolCall(runId, call.callId, {
          ok: false,
          error: `tool "${call.tool}" is not declared in this agent's toolRefs`,
        });
        return;
      }
      const tool = toolCatalog?.getById(call.tool);
      if (!tool) {
        await channel.resolveToolCall(runId, call.callId, {
          ok: false,
          error: `tool "${call.tool}" not found in the catalog`,
        });
        return;
      }
      try {
        const outcome = await dispatchResolvedTool(tool, call.input, toolDeps, opts);
        await channel.resolveToolCall(runId, call.callId, outcome);
      } catch (err) {
        await channel.resolveToolCall(runId, call.callId, {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
  };
}
