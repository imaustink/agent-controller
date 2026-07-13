import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Event } from "@controller-agent/messaging";
import type { CallbackReceiver } from "../callback/receiver.js";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { IdentityResolver, Identity } from "../rbac/types.js";
import type { SkillDescriptor, SkillSearchResult, SkillStore } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { VectorStore } from "../vector-store/types.js";
import type { ActionPlanner } from "./action-planner.js";
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
  identity: Annotation<Identity | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  skillCandidates: Annotation<SkillSearchResult[]>({
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
}

function afterOrEnd(next: string) {
  return (state: AgentState): string => (state.error ? END : next);
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
    .addNode("selectSkill", async (state) => {
      if (state.skillCandidates.length === 0) {
        return { error: "no matching skill for this request" };
      }
      const selected = await deps.skillSelector.select(state.request, state.skillCandidates);
      if (!selected) {
        return { error: "no matching skill for this request" };
      }
      return { selectedSkill: selected };
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
      const input = state.toolArgs ?? state.request;

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

        await deps.containerToolLauncher.launch(tool.jobTemplate, {
          args: [input],
          env: { JOB_ID: jobId },
          callbackUrl,
          callbackSecret: deps.callbackSecret,
        });

        event = await awaitResult;
      } else {
        return { error: `tool ${tool.id} has neither a jobTemplate nor a localExec spec` };
      }

      if (event.type === "failed") {
        return { jobId, error: `tool failed (${event.code}): ${event.message}` };
      }
      if (event.type !== "succeeded") {
        return { jobId, result: undefined };
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
      // byte-for-byte — the composer only produces optional surrounding text —
      // so the recipe Markdown and its `<!-- mealie-slug: ... -->` marker
      // survive verbatim for next-turn intent detection.
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
    // Active skill confirmed -> skip retrieval + selection entirely;
    // otherwise fall through to the full RAG path (docs/adr/0012).
    .addConditionalEdges("checkActiveSkill", (state) =>
      state.error ? END : state.selectedSkill ? "loadSkillTools" : "retrieveSkills",
    )
    .addConditionalEdges("retrieveSkills", afterOrEnd("selectSkill"))
    .addConditionalEdges("selectSkill", afterOrEnd("loadSkillTools"))
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
