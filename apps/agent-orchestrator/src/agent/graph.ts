import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Event } from "@controller-agent/messaging";
import type { AgentOrchestratorChannel } from "../agents/nats-agent-channel.js";
import { AgentTurnFailedError, AgentTurnTimeoutError } from "../agents/nats-agent-channel.js";
import type { AgentDescriptor, AgentSearchResult, AgentStore } from "../agents/types.js";
import type { CallbackReceiver } from "../callback/receiver.js";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { AgentRunLauncherPort } from "../k8s/agentrun-launcher.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { IdentityResolver, Identity } from "../rbac/types.js";
import type { SkillDescriptor, SkillSearchResult, SkillStore } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { VectorStore } from "../vector-store/types.js";
import type { ActionPlanner } from "./action-planner.js";
import type { DelegateSelector } from "./delegate-selector.js";
import type { ResponseComposer } from "./response-composer.js";
import type { SkillFitChecker } from "./skill-fit-checker.js";
import { extractContinuationToken, prependContinuationToken } from "../continuation.js";

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
  /**
   * Per-tool continuation tokens from the session store (docs/adr/0016),
   * keyed by tool id. The `runTool` node prepends the stored token to the
   * tool's input before launch so the tool can resume multi-turn state
   * without it ever appearing in the chat transcript the LLM sees.
   */
  toolContinuations: Annotation<Record<string, string>>({
    reducer: (_current, update) => update,
    default: () => ({}),
  }),
  /**
   * Continuation token extracted from the tool's success output this turn
   * (docs/adr/0016). Set by `runTool` when the result begins with a
   * `<!-- continuation: ... -->` marker; the token is stripped from `result`
   * before it is surfaced to the user. The server persists this back into the
   * session store after a successful turn.
   */
  extractedContinuation: Annotation<{ toolId: string; token: string } | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Per-request progress listener — set by the SSE streaming path so tool
   * Job progress/warning callback events are forwarded as Open WebUI status
   * steps while the Job runs. Absent on non-streaming paths; keeping it in
   * state (not in deps) guarantees concurrent requests each have their own
   * handler without shared-mutable-state races.
   */
  progressListener: Annotation<((stage: string, message: string | undefined) => void) | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

export interface AgentGraphDeps {
  identityResolver: IdentityResolver;
  skillStore: SkillStore;
  skillFitChecker: SkillFitChecker;
  vectorStore: VectorStore;
  actionPlanner: ActionPlanner;
  responseComposer: ResponseComposer;
  containerToolLauncher: ContainerToolLauncher;
  callbackReceiver: CallbackReceiver;
  /**
   * Executor for LocalTools (ADR 0014) — tools run in-pod by a per-language
   * sidecar instead of as a k8s Job. Optional: when absent, a selected
   * LocalTool fails gracefully rather than crashing the graph.
   */
  localToolExecutor?: LocalToolExecutor;
  /** Base URL the launched Job's callback should target, e.g. http://agent-orchestrator.default.svc:8080 */
  callbackBaseUrl: string;
  callbackSecret: string;
  skillTopK?: number;
  /** Agent catalog (RAG index), retrieved alongside skills as an equally-weighted top-level delegation target. */
  agentStore: AgentStore;
  /** Picks ONE delegation target — a skill or an agent — from both candidate lists at once. */
  delegateSelector: DelegateSelector;
  /** Creates the AgentRun CR the tool-controller reconciles into a hardened Job. */
  agentRunLauncher: AgentRunLauncherPort;
  /** Bidirectional NATS channel to a running agent (progress, human-in-the-loop questions, final reply). */
  agentChannel: AgentOrchestratorChannel;
  /** Max candidate agents retrieved per request, before delegate selection (mirrors skillTopK). */
  agentTopK?: number;
  /** Bounds an AgentRun's activeDeadlineSeconds — typically longer than a tool's, since an agent may wait on a human. */
  agentRunTimeoutSeconds?: number;
  /** k8s Secret name/key the AgentRun CR's (currently vestigial) callback field references — reuses the same secretRef as ToolRun. */
  callbackSecretRef: { name: string; key: string };
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
      // mismatch, agent gone, roles revoked) falls through to full
      // retrieval + selection, same discipline as checkActiveSkill.
      if (state.selectedSkill) return {}; // checkActiveSkill already resolved this turn
      if (!state.activeAgentRunId || !state.activeAgentId || !state.identity) return {};
      if (state.sessionSubject !== state.identity.subject) return {};
      const [found] = await deps.agentStore.getByIds([state.activeAgentId], {
        callerRoles: state.identity.roles,
      });
      if (!found) return {};

      try {
        const awaitReply = deps.agentChannel.awaitReply(state.activeAgentRunId);
        await deps.agentChannel.sendPrompt(state.activeAgentRunId, state.request);
        const reply = await awaitReply;
        const message = reply.narration.length > 0 ? `${reply.narration.join("\n")}\n\n${reply.message}` : reply.message;
        return {
          selectedAgent: found.agent,
          agentRunId: state.activeAgentRunId,
          agentAwaitingReply: !reply.final,
          result: message,
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
      if (!state.identity) return { agentCandidates: [] };
      const agentCandidates = await deps.agentStore.query(
        state.request,
        { callerRoles: state.identity.roles },
        deps.agentTopK ?? 3,
      );
      return { agentCandidates };
    })
    .addNode("selectDelegate", async (state) => {
      if (state.skillCandidates.length === 0 && state.agentCandidates.length === 0) {
        return { error: "no matching skill or agent for this request" };
      }
      const choice = await deps.delegateSelector.select(state.request, state.skillCandidates, state.agentCandidates);
      if (!choice) {
        return { error: "no matching skill or agent for this request" };
      }
      if (choice.type === "agent") {
        return { selectedAgent: choice.agent };
      }
      return { selectedSkill: choice.skill };
    })
    .addNode("delegateToAgent", async (state) => {
      if (!state.selectedAgent || !state.identity) {
        return { error: "no agent selected" };
      }
      const agent = state.selectedAgent;
      const runId = randomUUID();
      const jobId = randomUUID();
      const callbackUrl = `${deps.callbackBaseUrl}/callback/${jobId}`;

      try {
        // Subscribe BEFORE creating the AgentRun CR so a fast-replying agent
        // can never publish before our subscription exists.
        const awaitReply = deps.agentChannel.awaitReply(runId);
        await deps.agentRunLauncher.launch(agent.agentRunTemplate, runId, {
          goal: state.request,
          callbackUrl,
          callbackSecretRef: deps.callbackSecretRef,
          timeoutSeconds: deps.agentRunTimeoutSeconds,
        });
        const reply = await awaitReply;
        const message = reply.narration.length > 0 ? `${reply.narration.join("\n")}\n\n${reply.message}` : reply.message;
        return {
          agentRunId: runId,
          agentAwaitingReply: !reply.final,
          result: message,
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
      return { selectedTool: tool, toolArgs: planned.toolArgs };
    })
    .addNode("runTool", async (state) => {
      const tool = state.selectedTool;
      if (!tool) {
        return { error: "no tool selected" };
      }
      const rawInput = state.toolArgs ?? state.request;
      // Inject any stored continuation token for this tool (docs/adr/0016):
      // prepend as a `<!-- continuation: ... -->` marker so the tool can
      // resume multi-turn state without the token ever appearing in the chat
      // transcript that the LLM planner sees.
      const storedToken = state.toolContinuations[tool.id];
      const input = storedToken ? prependContinuationToken(storedToken, rawInput) : rawInput;

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
        const callbackUrl = `${deps.callbackBaseUrl}/callback/${jobId}`;
        const awaitResult = deps.callbackReceiver.awaitJob(jobId);

        // Register the per-request progress handler (if any) before launching
        // so no early events are missed. The handler lives in state — not in
        // shared deps — so concurrent requests never cross-contaminate.
        const unsubscribeProgress = state.progressListener
          ? deps.callbackReceiver.onJobProgress(jobId, state.progressListener)
          : () => undefined;

        try {
          await deps.containerToolLauncher.launch(tool.jobTemplate, {
            args: [input],
            env: { JOB_ID: jobId },
            callbackUrl,
            callbackSecret: deps.callbackSecret,
          });

          event = await awaitResult;
        } finally {
          unsubscribeProgress();
        }
      } else {
        return { error: `tool ${tool.id} has neither a jobTemplate nor a localExec spec` };
      }

      if (event.type === "failed") {
        return { jobId, error: `tool failed (${event.code}): ${event.message}` };
      }
      if (event.type !== "succeeded") {
        return { jobId, result: undefined };
      }
      // Extract and strip a leading `<!-- continuation: ... -->` marker from
      // the tool's success output (docs/adr/0016). The token is stored in the
      // session by the server after this turn; the stripped result is surfaced
      // to the user so the token never appears in the chat transcript.
      const rawResult = typeof event.result === "string" ? event.result : null;
      if (rawResult !== null) {
        const { token, text: strippedResult } = extractContinuationToken(rawResult);
        if (token) {
          return { jobId, result: strippedResult, extractedContinuation: { toolId: tool.id, token } };
        }
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
    // way; a miss (agentRunId still unset) falls through to full retrieval.
    .addConditionalEdges("checkActiveAgentRun", (state) => (state.error || state.agentRunId ? END : "retrieveSkills"))
    .addConditionalEdges("retrieveSkills", afterOrEnd("retrieveAgents"))
    .addConditionalEdges("retrieveAgents", afterOrEnd("selectDelegate"))
    // selectDelegate branches three ways: error -> END, a skill was picked ->
    // loadSkillTools (existing flow, unchanged), an agent was picked ->
    // delegateToAgent.
    .addConditionalEdges("selectDelegate", (state) => {
      if (state.error) return END;
      return state.selectedAgent ? "delegateToAgent" : "loadSkillTools";
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
