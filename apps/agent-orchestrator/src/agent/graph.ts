import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Event } from "@controller-agent/messaging";
import { extractContinuationToken, prependContinuationToken } from "../continuation.js";
import type { AgentOrchestratorChannel, AgentTurnResult } from "../agents/nats-agent-channel.js";
import { AgentTurnFailedError, AgentTurnTimeoutError } from "../agents/nats-agent-channel.js";
import type { AgentDescriptor, AgentSearchResult, AgentStore } from "../agents/types.js";
import type { JobResultReceiver } from "../callback/receiver.js";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { AgentRunLauncherPort } from "../k8s/agentrun-launcher.js";
import type { SecretKeySelector } from "../k8s/toolrun-launcher.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { IdentityResolver, Identity } from "../rbac/types.js";
import type { SkillDescriptor, SkillSearchResult, SkillStore } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { VectorStore } from "../vector-store/types.js";
import type { ActionPlanner } from "./action-planner.js";
import type { DelegateSelector } from "./delegate-selector.js";
import type { ResponseComposer } from "./response-composer.js";
import type { SkillFitChecker } from "./skill-fit-checker.js";
import type { SkillSelector } from "./skill-selector.js";

/**
 * Agent state threaded through the graph (docs/adr/0008, docs/adr/0012,
 * docs/orchestrator.md): resolve identity -> re-check the conversation's
 * active skill if one exists (fit-check first, RAG on miss) -> otherwise
 * retrieve candidate skills (RAG, RBAC-filtered) and select one -> load the
 * tools that skill declares -> plan an action (respond directly, or call one
 * of those tools) -> if a tool was chosen, run it (a container tool via a
 * ToolRun CR + callback, or a LocalTool in-pod) and await its result ->
 * compose the final turn, letting the skill's own instructions add any
 * follow-up narration around the tool's verbatim output (docs/adr/0015).
 */
export const AgentStateAnnotation = Annotation.Root({
  request: Annotation<string>,
  authToken: Annotation<string>,
  /**
   * The conversation's active skill id from the caller's session, if any
   * (docs/adr/0012). Set by the server from the session store, consumed by
   * the `checkActiveSkill` node; absent -> stateless per-turn selection.
   */
  activeSkillId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Identity subject the session record was created under. Conversation ids
   * are caller-supplied and guessable, so the active skill is only honored
   * when this matches the freshly resolved identity (docs/adr/0012).
   */
  sessionSubject: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Id of the Agent CR the conversation is continuing (if any), from the
   * caller's session. Set by the server, consumed by `checkActiveAgentRun`;
   * mutually exclusive with `activeSkillId` in practice (a conversation is
   * either continuing a skill or continuing a running agent, never both).
   */
  activeAgentId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** Name of the specific `AgentRun` CR the conversation is continuing, if any. */
  activeAgentRunId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Per-tool continuation tokens from the caller's session, keyed by tool id
   * (docs/adr/0017). Set by the server from the session store, consumed by
   * `runTool` to prefix the tool's args on a repeat call for the same tool.
   */
  toolContinuations: Annotation<Record<string, string> | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Per-agent continuation tokens from the caller's session, keyed by agent
   * id (docs/adr/0017) — the AgentRun analogue of `toolContinuations`. Set
   * by the server from the session store, consumed by `delegateToAgent` to
   * prefix the goal of a NEW AgentRun episode for the same agent.
   */
  agentContinuations: Annotation<Record<string, string> | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  identity: Annotation<Identity | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  skillCandidates: Annotation<SkillSearchResult[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  agentCandidates: Annotation<AgentSearchResult[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  selectedSkill: Annotation<SkillDescriptor | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  skillTools: Annotation<ToolDescriptor[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  selectedTool: Annotation<ToolDescriptor | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** The exact argument string to pass to `selectedTool`, distinct from the raw `request` (docs/adr/0008). */
  toolArgs: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * For a multi-instance tool, the planner's stable identifier for WHICH
   * instance this call is about (docs/adr/0017), e.g. a recipe's source URL
   * for recipe-publisher — keeps that tool's per-instance continuation
   * state from being conflated across distinct instances in one
   * conversation. Absent for tools that don't need instance-scoping.
   */
  toolInstanceKey: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  jobId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  result: Annotation<unknown>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  error: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** Descriptor of the sub-agent selected for this turn (agent delegation path). */
  selectedAgent: Annotation<AgentDescriptor | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Name of the AgentRun CR this turn launched or continued — set whenever an
   * agent produced a reply (question or final), so the server can persist it
   * for the next turn's continuation and narrate progress.
   */
  agentRunId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * True when the agent's reply this turn was a question (non-final) and the
   * conversation should continue this SAME AgentRun next turn; false once the
   * agent is done (final reply) or on failure — either way the session's
   * agent-continuation fields should be cleared, not carried forward.
   */
  agentAwaitingReply: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
  /**
   * Opaque continuation token extracted from the tool's succeeded result
   * (e.g. `<!-- continuation: <slug> -->`). Stored in the session store and
   * re-injected into tool_args on the next turn for the same tool (ADR 0016).
   * An empty-string token means "clear the stored continuation for this
   * tool id" (the tool ran but returned no marker this time).
   */
  extractedContinuation: Annotation<{ toolId: string; token: string } | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Opaque continuation token from the agent's structured `reply.result`
   * (docs/adr/0017) — the AgentRun analogue of `extractedContinuation`.
   * Stored in the session store and re-injected as a goal prefix on the
   * NEXT episode's `delegateToAgent` call for the same agent.
   */
  extractedAgentContinuation: Annotation<{ agentId: string; token: string } | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Per-request progress listener — set by the SSE streaming path so tool
   * Job progress/warning events (and, for agent delegation, the sub-agent's
   * own narration) are forwarded as Open WebUI status steps while the Job
   * runs. Absent on non-streaming paths; keeping it in state (not in deps)
   * guarantees concurrent requests each have their own handler without
   * shared-mutable-state races.
   */
  progressListener: Annotation<((stage: string, message: string | undefined) => void) | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * True when `selectDelegate` found no matching Skill/Agent candidate at
   * all and fell back to `deps.fallbackAgent` as a best-effort attempt,
   * rather than a request that genuinely matched an agent. Read by
   * `delegateToAgent` to append a self-improvement suggestion onto the
   * composed message.
   */
  wasFallback: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

export interface AgentGraphDeps {
  identityResolver: IdentityResolver;
  skillStore: SkillStore;
  skillSelector: SkillSelector;
  skillFitChecker: SkillFitChecker;
  vectorStore: VectorStore;
  actionPlanner: ActionPlanner;
  responseComposer: ResponseComposer;
  containerToolLauncher: ContainerToolLauncher;
  /**
   * Receives terminal (succeeded/failed) and intermediate (progress/warning)
   * events from launched tool Jobs. Backed by HTTP (`CallbackReceiver`) when
   * no NATS URL is configured, or NATS (`NatsJobReceiver`) otherwise.
   */
  jobResultReceiver: JobResultReceiver;
  /**
   * Executor for LocalTools (ADR 0014) — tools run in-pod by a per-language
   * sidecar instead of as a k8s Job. Optional: when absent, a selected
   * LocalTool fails gracefully rather than crashing the graph.
   */
  localToolExecutor?: LocalToolExecutor;
  /**
   * HTTP mode: base URL Jobs use to reach the callback receiver.
   * Required when `natsUrl` is absent; ignored when `natsUrl` is set.
   */
  callbackBaseUrl?: string;
  /**
   * HTTP mode: HMAC secret for signing/verifying callback bodies.
   * Required when `natsUrl` is absent; ignored when `natsUrl` is set.
   */
  callbackSecret?: string;
  /**
   * NATS mode: URL of the NATS server (e.g. nats://nats.svc:4222).
   * When set, tool results are delivered over NATS instead of HTTP callbacks.
   */
  natsUrl?: string;
  skillTopK?: number;
  /**
   * Agent catalog (RAG index), retrieved alongside skills as an equally-
   * weighted top-level delegation target. Agent delegation as a whole is
   * only meaningful over NATS (it needs a live bidirectional channel to a
   * long-running Job), so this bundle of deps is optional: absent ->
   * `retrieveAgents`/`checkActiveAgentRun` degrade to no-ops and the graph
   * behaves exactly as it does today (skills only).
   */
  agentStore?: AgentStore;
  /** Picks ONE delegation target — a skill or an agent — from both candidate lists at once. */
  delegateSelector?: DelegateSelector;
  /** Creates the AgentRun CR the tool-controller reconciles into a hardened Job. */
  agentRunLauncher?: AgentRunLauncherPort;
  /** Bidirectional NATS channel to a running agent (progress, human-in-the-loop questions, final reply). */
  agentChannel?: AgentOrchestratorChannel;
  /** Max candidate agents retrieved per request, before delegate selection (mirrors skillTopK). */
  agentTopK?: number;
  /** Bounds an AgentRun's activeDeadlineSeconds — typically longer than a tool's, since an agent may wait on a human. */
  agentRunTimeoutSeconds?: number;
  /**
   * k8s Secret name/key the AgentRun CR's (currently vestigial) callback
   * field references — reuses the same secretRef as ToolRun. Required
   * whenever `agentRunLauncher` is set.
   */
  callbackSecretRef?: SecretKeySelector;
  /**
   * Best-effort delegation target for a turn that matches no Skill/Agent
   * candidate at all — instead of failing closed, `selectDelegate` hands the
   * raw request to this agent, and `delegateToAgent` marks the resulting
   * message with a self-improvement suggestion (a permanent skill can be
   * authored for it next time). Absent -> today's fail-closed behavior is
   * unchanged. Only meaningful alongside `agentRunLauncher`/`agentChannel`.
   */
  fallbackAgent?: AgentDescriptor;
  /**
   * Max candidate tools retrieved when attempting a direct fallback tool call
   * (selectFallbackTool), before the fallback agent is tried. Mirrors
   * skillTopK/agentTopK.
   */
  fallbackToolTopK?: number;
}

function afterOrEnd(next: string) {
  return (state: AgentState): string => (state.error ? END : next);
}

/** Normalizes an agent-turn failure (from awaitReply/sendPrompt) into a state.error message. */
function agentTurnErrorMessage(err: unknown): string {
  if (err instanceof AgentTurnFailedError) return `agent failed (${err.code}): ${err.message}`;
  if (err instanceof AgentTurnTimeoutError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

/**
 * When a live progress listener is attached (the SSE streaming path), the
 * delegated agent's narrative was already streamed to the user as it was
 * generated (server.ts's "agent-text" content-delta handling). The agent's
 * final `message` — `<!-- swe: ... --> + summary + "---" PR footer`
 * (apps/opencode-swe-agent/src/index.ts) — would duplicate that narrative if
 * returned whole, so keep only the parts that were NOT already streamed: the
 * leading marker (invisible, needed for next-turn continuity) and the
 * trailing "---" footer (the PR link). Falls back to the full message if the
 * expected shape isn't found, so a format drift shows the user something
 * rather than silently dropping the PR link.
 */
function dropStreamedNarrative(message: string): string {
  const markerMatch = message.match(/^<!--[\s\S]*?-->\n*/);
  const marker = markerMatch?.[0] ?? "";
  const rest = message.slice(marker.length);
  const footerIdx = rest.lastIndexOf("\n\n---\n");
  if (footerIdx < 0) return message;
  return `${marker}${rest.slice(footerIdx)}`;
}

/**
 * Composes the visible message for a finished (or paused) agent turn.
 * Non-streaming callers (no progress listener) never saw any of this live,
 * so they get the collected narration prepended as a fallback transcript.
 * Streaming callers already watched the narrative go by as content deltas,
 * so duplicating it here would repeat the whole summary in the chat.
 */
function composeAgentTurnMessage(state: Pick<AgentState, "progressListener">, reply: AgentTurnResult): string {
  if (state.progressListener) return dropStreamedNarrative(reply.message);
  return reply.narration.length > 0 ? `${reply.narration.join("\n")}\n\n${reply.message}` : reply.message;
}

/**
 * How long the orchestrator waits on NATS for an agent's reply. Must be at
 * least as long as the k8s Job's own `activeDeadlineSeconds`
 * (`deps.agentRunTimeoutSeconds`) plus a grace period, so a run that hits its
 * own deadline gets the chance to publish a `failed` event (a clear, specific
 * error) before the orchestrator's client-side wait gives up first with a
 * generic "produced no reply" timeout. Falls back to nats-agent-channel.ts's
 * own default when no deadline is configured.
 */
const AGENT_TIMEOUT_GRACE_MS = 60_000;
function agentAwaitReplyTimeoutMs(agentRunTimeoutSeconds: number | undefined): number | undefined {
  return agentRunTimeoutSeconds ? agentRunTimeoutSeconds * 1000 + AGENT_TIMEOUT_GRACE_MS : undefined;
}

/**
 * Appended to a fallback delegation's final reply (`state.wasFallback`) so
 * the caller knows this turn was handled ad-hoc — no Skill or Agent matched
 * it — and can ask for a permanent skill to be authored for next time.
 */
function appendSelfImprovementSuggestion(message: string): string {
  return `${message}\n\n---\nNo existing skill or agent matched this request, so it was handled ad-hoc. Ask me to run the self-improvement skill if you'd like a permanent skill added for this next time.`;
}

/**
 * System-prompt content for the fallback tool-fit decision below — the
 * synthetic-skill counterpart of a real Skill's `markdown` (ADR 0008). A real
 * skill's markdown carries authored procedural guidance (when to call which
 * tool, when not to); a request that reaches this fallback has none of that,
 * so this instructs the planner to be conservative — only call a tool that is
 * an unambiguous fit for the raw catalog description, and decline otherwise
 * rather than force a poor match.
 */
const FALLBACK_TOOL_MARKDOWN = [
  "No dedicated skill matched this request. You are deciding, from the raw tool catalog below (with no",
  "authored procedural guidance for how these tools relate or when to use them), whether exactly one of",
  "them is an unambiguous fit for the request.",
  "Only call a tool when its description is a clear, direct match — if the fit is unclear, or the request",
  "would need multiple tools or steps to satisfy, decline (respond) rather than force a guess; a",
  "best-effort fallback agent will attempt the task next.",
].join(" ");

/**
 * Best-effort direct tool call for a request that matched no Skill or Agent
 * (graph.ts's selectDelegate) — tried BEFORE the (more expensive, more
 * general) fallback agent, since a clean single-tool fit is cheaper and more
 * predictable than a full agent run. Reuses the existing action planner
 * against a synthetic skill (no real Skill exists for this turn) scoped to
 * the top-K tool-catalog candidates, same RBAC discipline as loadSkillTools.
 * Returns undefined when no tool fits (or none are visible to this caller) —
 * the caller falls through to the agent fallback in that case.
 */
async function selectFallbackTool(
  state: AgentState,
  deps: AgentGraphDeps,
): Promise<{ tool: ToolDescriptor; toolArgs: string; toolInstanceKey?: string } | undefined> {
  if (!state.identity) return undefined;
  const candidates = await deps.vectorStore.query(state.request, { callerRoles: state.identity.roles }, deps.fallbackToolTopK ?? 3);
  if (candidates.length === 0) return undefined;
  const tools = candidates.map((c) => c.tool);
  const syntheticSkill: SkillDescriptor = {
    id: "__fallback_tool__",
    name: "Fallback tool selection",
    description: "",
    markdown: FALLBACK_TOOL_MARKDOWN,
    toolIds: tools.map((t) => t.id),
  };
  const planned = await deps.actionPlanner.plan(state.request, syntheticSkill, tools);
  if (planned.action !== "call_tool") return undefined;
  const tool = tools.find((t) => t.id === planned.toolId);
  if (!tool) return undefined;
  return { tool, toolArgs: planned.toolArgs, ...(planned.toolInstanceKey ? { toolInstanceKey: planned.toolInstanceKey } : {}) };
}

/**
 * The full no-match cascade for `selectDelegate`: try a direct single-tool
 * fit first (cheap, deterministic), then the configured fallback agent (a
 * full agent run — general-purpose but expensive and non-deterministic), and
 * only fail closed if neither is available/applicable. Shared by every
 * "nothing matched" branch in selectDelegate so the cascade is applied
 * uniformly regardless of whether agent delegation (NATS) is configured.
 */
async function noMatchFallback(state: AgentState, deps: AgentGraphDeps): Promise<Partial<AgentState>> {
  const toolFallback = await selectFallbackTool(state, deps);
  if (toolFallback) {
    return {
      selectedTool: toolFallback.tool,
      toolArgs: toolFallback.toolArgs,
      toolInstanceKey: toolFallback.toolInstanceKey,
      wasFallback: true,
    };
  }
  if (deps.fallbackAgent) return { selectedAgent: deps.fallbackAgent, wasFallback: true };
  return { error: "no matching skill or agent for this request" };
}

/** Builds and compiles the LangGraph.js agent graph (docs/adr/0008, superseding the earlier flat tool-RAG flow). */
export function buildAgentGraph(deps: AgentGraphDeps) {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("resolveIdentity", async (state) => {
      const identity = await deps.identityResolver.resolve(state.authToken);
      if (!identity) {
        return { error: "unauthorized: could not resolve caller identity" };
      }
      return { identity };
    })
    .addNode("checkActiveSkill", async (state) => {
      // Session-scoped skill continuity (docs/adr/0012): if the conversation
      // already has an active skill, re-fetch it under the caller's CURRENT
      // roles and ask a cheap fit-check whether this turn still belongs to
      // it. Every miss (no session, subject mismatch, skill gone, roles
      // revoked, turn doesn't fit) falls through to full retrieval +
      // selection -- a miss is never an error.
      if (!state.activeSkillId || !state.identity) return {};
      if (state.sessionSubject !== state.identity.subject) return {};
      const [skill] = await deps.skillStore.getByIds([state.activeSkillId], {
        callerRoles: state.identity.roles,
      });
      if (!skill) return {};
      const fits = await deps.skillFitChecker.fits(state.request, skill);
      if (!fits) return {};
      return { selectedSkill: skill };
    })
    .addNode("checkActiveAgentRun", async (state) => {
      // Agent-continuation counterpart to checkActiveSkill: if the
      // conversation is already mid-delegation to an agent (it asked a
      // question and is waiting), re-verify the caller can still use that
      // Agent under their CURRENT roles, then forward this turn's message as
      // a `prompt` to the SAME AgentRun and await its next reply — no
      // retrieval/selection needed. Every miss (no session, subject
      // mismatch, agent gone, roles revoked, agent delegation not
      // configured) falls through to full retrieval + selection, same
      // discipline as checkActiveSkill.
      if (state.selectedSkill) return {}; // checkActiveSkill already resolved this turn
      if (!deps.agentStore || !deps.agentChannel) return {};
      if (!state.activeAgentRunId || !state.activeAgentId || !state.identity) return {};
      if (state.sessionSubject !== state.identity.subject) return {};
      const [found] = await deps.agentStore.getByIds([state.activeAgentId], {
        callerRoles: state.identity.roles,
      });
      if (!found) return {};

      try {
        const awaitReply = deps.agentChannel.awaitReply(state.activeAgentRunId, {
          timeoutMs: agentAwaitReplyTimeoutMs(deps.agentRunTimeoutSeconds),
          onProgress: state.progressListener ? (stage, message) => state.progressListener!(stage ?? "agent", message) : undefined,
        });
        await deps.agentChannel.sendPrompt(state.activeAgentRunId, state.request);
        const reply = await awaitReply;
        const message = composeAgentTurnMessage(state, reply);
        return {
          selectedAgent: found.agent,
          agentRunId: state.activeAgentRunId,
          agentAwaitingReply: !reply.final,
          result: message,
          // Same rule as delegateToAgent: only a FINAL reply concludes the
          // episode, at which point `reply.result` becomes the continuation
          // token for whatever NEW episode comes next (ADR 0017).
          ...(reply.final
            ? { extractedAgentContinuation: { agentId: found.agent.id, token: typeof reply.result === "string" ? reply.result : "" } }
            : {}),
        };
      } catch (err) {
        return { agentRunId: state.activeAgentRunId, error: agentTurnErrorMessage(err) };
      }
    })
    .addNode("retrieveSkills", async (state) => {
      // Unreachable without an identity (conditional edge below), but keep
      // the fail-closed check local to this node too.
      if (!state.identity) return { skillCandidates: [] };
      const skillCandidates = await deps.skillStore.query(
        state.request,
        { callerRoles: state.identity.roles },
        deps.skillTopK ?? 3,
      );
      return { skillCandidates };
    })
    .addNode("retrieveAgents", async (state) => {
      if (!deps.agentStore || !state.identity) return { agentCandidates: [] };
      const agentCandidates = await deps.agentStore.query(
        state.request,
        { callerRoles: state.identity.roles },
        deps.agentTopK ?? 3,
      );
      return { agentCandidates };
    })
    .addNode("selectDelegate", async (state) => {
      // Full skill+agent delegate selection when agent delegation is
      // configured (NATS deployments); a plain skill-only selection
      // otherwise, so the graph degrades gracefully without NATS.
      if (deps.delegateSelector) {
        if (state.skillCandidates.length === 0 && state.agentCandidates.length === 0) {
          return noMatchFallback(state, deps);
        }
        const choice = await deps.delegateSelector.select(state.request, state.skillCandidates, state.agentCandidates);
        if (!choice) {
          return noMatchFallback(state, deps);
        }
        if (choice.type === "agent") {
          return { selectedAgent: choice.agent };
        }
        return { selectedSkill: choice.skill };
      }
      if (state.skillCandidates.length === 0) {
        return noMatchFallback(state, deps);
      }
      const selected = await deps.skillSelector.select(state.request, state.skillCandidates);
      if (!selected) {
        return noMatchFallback(state, deps);
      }
      return { selectedSkill: selected };
    })
    .addNode("delegateToAgent", async (state) => {
      if (!deps.agentRunLauncher || !deps.agentChannel || !deps.callbackSecretRef) {
        return { error: "agent delegation is not configured" };
      }
      if (!state.selectedAgent || !state.identity) {
        return { error: "no agent selected" };
      }
      const agent = state.selectedAgent;
      const runId = randomUUID();
      const jobId = randomUUID();
      const callbackUrl = `${deps.callbackBaseUrl}/callback/${jobId}`;
      // Re-inject this agent's saved continuation token (if any) onto the new
      // episode's goal — e.g. opencode-swe's repo/branch/pr/session, so a
      // follow-up coding task resumes the same branch without that state ever
      // having round-tripped through the chat transcript (ADR 0017,
      // superseding the old `<!-- swe: ... -->` marker).
      const priorToken = state.agentContinuations?.[agent.id];
      const goal = priorToken ? prependContinuationToken(priorToken, state.request) : state.request;

      try {
        // Subscribe BEFORE creating the AgentRun CR so a fast-replying agent
        // can never publish before our subscription exists.
        const awaitReply = deps.agentChannel.awaitReply(runId, {
          timeoutMs: agentAwaitReplyTimeoutMs(deps.agentRunTimeoutSeconds),
          onProgress: state.progressListener ? (stage, message) => state.progressListener!(stage ?? "agent", message) : undefined,
        });
        await deps.agentRunLauncher.launch(agent.agentRunTemplate, runId, {
          goal,
          callbackUrl,
          callbackSecretRef: deps.callbackSecretRef,
          timeoutSeconds: deps.agentRunTimeoutSeconds,
        });
        const reply = await awaitReply;
        const message = composeAgentTurnMessage(state, reply);
        return {
          agentRunId: runId,
          agentAwaitingReply: !reply.final,
          result: state.wasFallback && reply.final ? appendSelfImprovementSuggestion(message) : message,
          // Only a FINAL reply concludes an episode, so only then is
          // `reply.result` the continuation token for the NEXT episode — a
          // non-final reply (HITL question) continues this SAME run via
          // `checkActiveAgentRun`, which needs no continuation token at all.
          ...(reply.final
            ? { extractedAgentContinuation: { agentId: agent.id, token: typeof reply.result === "string" ? reply.result : "" } }
            : {}),
        };
      } catch (err) {
        return { agentRunId: runId, error: agentTurnErrorMessage(err) };
      }
    })
    .addNode("loadSkillTools", async (state) => {
      if (!state.selectedSkill || !state.identity) {
        return { error: "no skill selected" };
      }
      // Respond-only skill (no toolIds, ADR 0011): nothing to load and
      // nothing to authorize -- the planner can only choose "respond".
      if (state.selectedSkill.toolIds.length === 0) {
        return { skillTools: [] };
      }
      const skillTools = await deps.vectorStore.getByIds(state.selectedSkill.toolIds, {
        callerRoles: state.identity.roles,
      });
      if (skillTools.length === 0) {
        // Should be unreachable now that skill visibility is derived from
        // tool RBAC (ADR 0011) -- kept as the fail-closed backstop for index
        // drift (e.g. a Tool CR deleted after startup indexing).
        return { error: "skill has no usable tools for this caller" };
      }
      return { skillTools: skillTools.map((r) => r.tool) };
    })
    .addNode("planAction", async (state) => {
      if (!state.selectedSkill) {
        return { error: "no skill selected" };
      }
      const planned = await deps.actionPlanner.plan(state.request, state.selectedSkill, state.skillTools);
      if (planned.action === "respond") {
        return { result: planned.response };
      }
      const tool = state.skillTools.find((t) => t.id === planned.toolId);
      if (!tool) {
        return { error: "planner selected a tool outside the skill's scope" };
      }
      return { selectedTool: tool, toolArgs: planned.toolArgs, toolInstanceKey: planned.toolInstanceKey };
    })
    .addNode("runTool", async (state) => {
      const tool = state.selectedTool;
      if (!tool) {
        return { error: "no tool selected" };
      }
      const rawInput = state.toolArgs ?? state.request;
      // Scope the stored continuation to the planner's declared instance (if
      // any) so a multi-instance tool's state for one instance (e.g. one
      // recipe's Mealie slug) is never conflated with another instance's
      // (a different recipe) within the same conversation (ADR 0017).
      const continuationKey = state.toolInstanceKey ? `${tool.id}::${state.toolInstanceKey}` : tool.id;
      // Re-inject this tool's saved continuation token (if any), so the tool
      // can resume state (e.g. an existing Mealie slug to update) without it
      // ever having round-tripped through the chat transcript.
      const priorToken = state.toolContinuations?.[continuationKey];
      const input = priorToken ? prependContinuationToken(priorToken, rawInput) : rawInput;

      if (tool.agentRunTemplate) {
        // Agent-backed tool: dispatch as an AgentRun over NATS, the same
        // mechanism the peer-level delegateToAgent path uses, instead of a
        // ToolRun Job. Lets a Skill's toolRefs reach a full agent loop (e.g.
        // a coding agent that opens PRs) via the ordinary tool-call path.
        if (!deps.agentRunLauncher || !deps.agentChannel || !deps.callbackSecretRef) {
          return { error: `tool ${tool.id} is agent-backed but agent delegation is not configured` };
        }
        const runId = randomUUID();
        const callbackUrl = `${deps.callbackBaseUrl}/callback/${randomUUID()}`;
        try {
          const awaitReply = deps.agentChannel.awaitReply(runId, {
            timeoutMs: agentAwaitReplyTimeoutMs(deps.agentRunTimeoutSeconds),
            onProgress: state.progressListener ? (stage, message) => state.progressListener!(stage ?? "agent", message) : undefined,
          });
          await deps.agentRunLauncher.launch(tool.agentRunTemplate, runId, {
            goal: input,
            callbackUrl,
            callbackSecretRef: deps.callbackSecretRef,
            timeoutSeconds: deps.agentRunTimeoutSeconds,
          });
          const reply = await awaitReply;
          // v1 scope cut: agent-backed tools support single-turn/final-reply
          // only — runTool has no session slot to resume a specific
          // tool-launched AgentRun the way checkActiveAgentRun does for
          // peer-level agent delegation. A clarifying (non-final) reply is
          // therefore reported as a clean error rather than silently
          // dropped or half-handled.
          if (!reply.final) {
            return { jobId: runId, error: `tool ${tool.id} (agent-backed) requires a single-turn agent — got a non-final reply` };
          }
          const message = composeAgentTurnMessage(state, reply);
          const { token, text } = extractContinuationToken(message);
          return {
            jobId: runId,
            result: state.wasFallback ? appendSelfImprovementSuggestion(text) : text,
            extractedContinuation: { toolId: continuationKey, token: token ?? "" },
          };
        } catch (err) {
          return { jobId: runId, error: agentTurnErrorMessage(err) };
        }
      }

      let jobId: string;
      let event: Event;
      if (tool.localExec) {
        // LocalTool (ADR 0014): run in-pod via the executor sidecar. No k8s
        // Job, no callback round-trip — the executor returns the tool's stdio
        // envelope as an Event directly, so the mapping below is identical.
        if (!deps.localToolExecutor) {
          return { error: `tool ${tool.id} is a LocalTool but local execution is not configured` };
        }
        event = await deps.localToolExecutor.run(tool, input);
        jobId = event.job_id;
      } else if (tool.jobTemplate) {
        // Container tool (ADR 0010): create a ToolRun CR — the Go
        // tool-controller reconciles it into a hardened Job. The orchestrator
        // itself never creates a Job.
        jobId = randomUUID();
        const awaitResult = deps.jobResultReceiver.awaitJob(jobId);

        // Register the per-request progress handler (if any) before launching
        // so no early events are missed. The handler lives in state — not in
        // shared deps — so concurrent requests never cross-contaminate.
        const unsubscribeProgress = state.progressListener
          ? deps.jobResultReceiver.onJobProgress(jobId, state.progressListener)
          : () => undefined;

        try {
          if (deps.natsUrl) {
            // NATS mode: tool publishes its result to `callbacks.<jobId>`.
            await deps.containerToolLauncher.launch(tool.jobTemplate, {
              args: [input],
              natsUrl: deps.natsUrl,
              natsSubject: `callbacks.${jobId}`,
            });
          } else {
            // HTTP callback mode (backward-compatible default).
            const callbackUrl = `${deps.callbackBaseUrl!}/callback/${jobId}`;
            await deps.containerToolLauncher.launch(tool.jobTemplate, {
              args: [input],
              callbackUrl,
              callbackSecret: deps.callbackSecret!,
            });
          }

          event = await awaitResult;
        } finally {
          unsubscribeProgress();
        }
      } else {
        return { error: `tool ${tool.id} has neither a jobTemplate, localExec, nor agentRunTemplate spec` };
      }

      if (event.type === "failed") {
        return { jobId, error: `tool failed (${event.code}): ${event.message}` };
      }
      if (event.type !== "succeeded") {
        return { jobId, result: undefined };
      }
      // A string result may carry a leading `<!-- continuation: ... -->`
      // marker (ADR 0017): strip it here so it never reaches the chat
      // transcript or the composeResponse/planner, and stash the token for
      // the server to persist against this call's (possibly instance-scoped)
      // key. Non-string (structured) results have no such marker.
      if (typeof event.result === "string") {
        const { token, text } = extractContinuationToken(event.result);
        return {
          jobId,
          result: state.wasFallback ? appendSelfImprovementSuggestion(text) : text,
          extractedContinuation: { toolId: continuationKey, token: token ?? "" },
        };
      }
      // The tool output is surfaced to the user verbatim; any follow-up
      // narration is added by the composeResponse node (docs/adr/0015), not
      // hard-coded here.
      return { jobId, result: event.result };
    })
    .addNode("composeResponse", async (state) => {
      // Post-tool response composition (docs/adr/0015): the active skill's own
      // instructions decide whether to wrap the tool's result with a follow-up
      // (e.g. "reply to confirm publishing"). The tool output is preserved
      // byte-for-byte — the composer only produces optional surrounding text.
      // Any `<!-- continuation: ... -->` marker was already stripped by
      // runTool and handed off server-side (ADR 0017), so the recipe
      // Markdown the user sees (and the next turn's intent detection over
      // it) never carries that marker at all.
      //
      // Only string results can be narrated in place; a structured (JSON)
      // result is passed straight through, so the node is a safe no-op outside
      // the string path.
      if (!state.selectedSkill || !state.selectedTool || typeof state.result !== "string") {
        return {};
      }
      const { prefix, suffix } = await deps.responseComposer.compose(
        state.request,
        state.selectedSkill,
        state.selectedTool,
        state.result,
      );
      if (!prefix && !suffix) return {};
      return { result: `${prefix ?? ""}${state.result}${suffix ?? ""}` };
    })
    .addEdge(START, "resolveIdentity")
    .addConditionalEdges("resolveIdentity", afterOrEnd("checkActiveSkill"))
    // Active skill confirmed -> skip straight to loadSkillTools; otherwise
    // check for a continuing agent run before falling through to full
    // retrieval (docs/adr/0012, extended to agents).
    .addConditionalEdges("checkActiveSkill", (state) =>
      state.error ? END : state.selectedSkill ? "loadSkillTools" : "checkActiveAgentRun",
    )
    // A continuing agent run either produced a terminal turn result
    // (question or final reply, agentRunId set) or errored -> END either
    // way; a miss (agentRunId still unset, e.g. no active run or agent
    // delegation not configured) falls through to full retrieval.
    .addConditionalEdges("checkActiveAgentRun", (state) => (state.error || state.agentRunId ? END : "retrieveSkills"))
    .addConditionalEdges("retrieveSkills", afterOrEnd("retrieveAgents"))
    .addConditionalEdges("retrieveAgents", afterOrEnd("selectDelegate"))
    // selectDelegate branches four ways: error -> END, a skill was picked ->
    // loadSkillTools (existing flow, unchanged), an agent was picked (either a
    // real match or the fallback agent) -> delegateToAgent, a tool was picked
    // directly with no skill (the fallback tool-fit path, noMatchFallback) ->
    // runTool, skipping loadSkillTools/planAction since there's no skill to
    // scope/plan against.
    .addConditionalEdges("selectDelegate", (state) => {
      if (state.error) return END;
      if (state.selectedAgent) return "delegateToAgent";
      if (!state.selectedSkill && state.selectedTool) return "runTool";
      return "loadSkillTools";
    })
    // Delegation is always terminal for THIS graph invocation — whether the
    // agent asked a question, gave its final reply, or failed. A follow-up
    // user turn is a NEW invocation that re-enters via checkActiveAgentRun.
    .addEdge("delegateToAgent", END)
    .addConditionalEdges("loadSkillTools", afterOrEnd("planAction"))
    // planAction branches three ways: error -> END, "respond" (result set,
    // no tool) -> END, "call_tool" (selectedTool set) -> runTool. A single
    // condition covers all three: only proceed to runTool when a tool was
    // actually selected.
    .addConditionalEdges("planAction", (state) => (state.error || !state.selectedTool ? END : "runTool"))
    // A failed/empty tool run ends the turn; a successful one flows into
    // composeResponse so the skill can add any follow-up (docs/adr/0015).
    .addConditionalEdges("runTool", (state) => (state.error || state.result === undefined ? END : "composeResponse"))
    .addEdge("composeResponse", END);

  return graph.compile();
}
