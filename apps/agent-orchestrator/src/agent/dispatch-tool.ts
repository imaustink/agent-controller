import { randomUUID } from "node:crypto";
import type { Event } from "@controller-agent/messaging";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { JobResultReceiver } from "../callback/receiver.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { MCPBrokerClient } from "../mcp/mcp-broker-client.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { AgentDescriptor } from "../agents/types.js";
import type { AgentOrchestratorChannel } from "../agents/nats-agent-channel.js";
import { approvalPrompt, requiresApproval, resolveApproval } from "./approval.js";

/** Outcome of dispatching one resolved Tool, reported back as a `tool_result` down-message (docs/adr/0028). */
export type ToolCallOutcome = { ok: true; result?: unknown } | { ok: false; error: string };

/** The subset of `AgentGraphDeps` {@link dispatchResolvedTool} needs to run a container/LocalTool. */
export interface ToolDispatchDeps {
  containerToolLauncher: ContainerToolLauncher;
  jobResultReceiver: JobResultReceiver;
  localToolExecutor?: LocalToolExecutor;
  /** Proxies an MCP tool call through the mcp-broker (ADR 0045). Absent when the broker is not configured. */
  mcpBrokerClient?: MCPBrokerClient;
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
  opts: { sessionId?: string; callerSubject?: string; agentApprovalDefault?: string } = {},
): Promise<ToolCallOutcome> {
  // Declarative tool-approval gate (ADR 0003), mirrored from `runTool` so a
  // sub-agent's own tool calls are governed by the same policy — resolved
  // most-specific-wins against the GOVERNING agent's `approvalDefault`. Covers
  // every dispatch kind at once by sitting ahead of the branches below.
  //
  // A sub-agent tool call has no human-in-the-loop channel to pause on (ADR
  // 0004 terminate-and-resume lives in the top-level graph, not here), so an
  // `always`/`auto` call fails closed with the approval prompt as a tool_result
  // the sub-agent's model can surface, rather than running unapproved.
  const effective = resolveApproval(tool.approval, opts.agentApprovalDefault);
  if (requiresApproval(effective)) {
    return { ok: false, error: approvalPrompt(tool.id) };
  }

  if (tool.agentRunTemplate) {
    return {
      ok: false,
      error: `tool ${tool.id} is agent-backed -- calling an agent-backed tool from a sub-agent's own toolRefs is not supported yet`,
    };
  }

  if (tool.mcpExec) {
    // MCP tool (docs/adr/0045): relayed through the mcp-broker as the caller,
    // the same in-process face `runTool` uses. A tool-level error or a missing
    // link is PROSE the sub-agent's model can act on (a successful outcome
    // carrying the message), not a dispatch failure — only the broker being
    // unreachable throws, which becomes an `{ok:false}` via the catch above us.
    if (!deps.mcpBrokerClient) {
      return { ok: false, error: `tool ${tool.id} is an MCP tool but the mcp-broker is not configured` };
    }
    if (!opts.callerSubject) {
      // Fail closed: a per-user MCP call runs AS someone, and a sub-agent tool
      // call with no resolved caller has nobody to run it as (docs/adr/0045 §5).
      return { ok: false, error: `tool ${tool.id} requires a resolved caller identity` };
    }
    const called = await deps.mcpBrokerClient.call(tool, input, { subject: opts.callerSubject });
    return { ok: true, result: called.result };
  }

  let event: Event;
  if (tool.localExec) {
    if (!deps.localToolExecutor) {
      return { ok: false, error: `tool ${tool.id} is a LocalTool but local execution is not configured` };
    }
    event = await deps.localToolExecutor.run(tool, input, opts.sessionId);
  } else if (tool.jobTemplate) {
    const jobId = randomUUID();
    // Intentionally NOT subscribing to `jobResultReceiver.onJobProgress` here,
    // unlike `runTool`'s equivalent container-Job branch (agent/graph.ts): a
    // sub-agent tool call has nowhere to route progress events, since
    // `AgentSession.callTool()` (packages/agent-runtime) exposes only a single
    // resolved result, no progress channel back to the calling sub-agent. The
    // omission is deliberate, not copy-paste drift from `runTool` (docs/adr/0028).
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
  opts: { sessionId?: string; callerSubject?: string } = {},
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
        const outcome = await dispatchResolvedTool(tool, call.input, toolDeps, {
          ...opts,
          // The governing agent's fallback policy (ADR 0003) — a tool's own
          // `approval` still wins inside `dispatchResolvedTool`.
          agentApprovalDefault: agent.approvalDefault,
        });
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
