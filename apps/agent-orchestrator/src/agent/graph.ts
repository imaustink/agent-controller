import { randomUUID } from "node:crypto";
import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import type { Event } from "@controller-agent/messaging";
import { extractContinuationToken, prependContinuationToken } from "../continuation.js";
import { SELF_IMPROVEMENT_FOOTER } from "../openai/chat-completions.js";
import type { AgentOrchestratorChannel, AgentTurnResult } from "../agents/nats-agent-channel.js";
import { AgentTurnFailedError, AgentTurnTimeoutError } from "../agents/nats-agent-channel.js";
import type { AgentDescriptor, AgentSearchResult, AgentStore } from "../agents/types.js";
import type { JobResultReceiver } from "../callback/receiver.js";
import type { ContainerToolLauncher } from "../k8s/container-tool-launcher.js";
import type { AgentRunLauncherPort } from "../k8s/agentrun-launcher.js";
import type { SecretKeySelector } from "../k8s/toolrun-launcher.js";
import type { LocalToolExecutor } from "../local/local-tool-executor.js";
import type { IdentityLinkPort } from "../identity-link/gateway-client.js";
import type { IdentityResolver, Identity } from "../rbac/types.js";
import type { SkillDescriptor, SkillSearchResult, SkillStore } from "../skills/types.js";
import type { ToolDescriptor } from "../tool-descriptor.js";
import type { VectorStore } from "../vector-store/types.js";
import type { ActionPlanner, ToolCallRecord } from "./action-planner.js";
import type { BestEffortResponder } from "./best-effort-responder.js";
import type { CapabilityNeedChecker } from "./capability-need-checker.js";
import type { DelegateSelector } from "./delegate-selector.js";
import type { ResponseComposer } from "./response-composer.js";
import type { SkillFitChecker } from "./skill-fit-checker.js";
import type { SkillSelector } from "./skill-selector.js";
import type { ToolFitChecker } from "./tool-fit-checker.js";

/**
 * Agent state threaded through the graph (docs/adr/0008, docs/adr/0012,
 * docs/adr/0019, docs/orchestrator.md): resolve identity -> re-check the
 * conversation's active skill if one exists (fit-check first, RAG on miss)
 * -> otherwise re-check a continuing agent run -> otherwise ask whether the
 * request plausibly needs a capability at all (docs/adr/0019); a "no"
 * short-circuits to a plain conversational answer with no catalog search and
 * no self-improvement suggestion -> a "yes" retrieves candidate skills and
 * agents (RAG, RBAC-filtered) and selects one -> load the tools that skill
 * declares -> plan an action (respond directly, or call one of those tools)
 * -> if a tool was chosen, run it (a container tool via a ToolRun CR +
 * callback, or a LocalTool in-pod) and await its result -> compose the final
 * turn, letting the skill's own instructions add any follow-up narration
 * around the tool's verbatim output (docs/adr/0015).
 */
export const AgentStateAnnotation = Annotation.Root({
  request: Annotation<string>,
  authToken: Annotation<string>,
  /**
   * Caller's Open WebUI session id, if any (docs/adr/0012) -- forwarded
   * verbatim to every ToolRun/AgentRun CR this turn launches, as an
   * annotation, purely for `kubectl describe`-level debugging. Not the same
   * concept as `sessionSubject` below (which gates active-skill/agent-run
   * continuation), and not required for continuation to work.
   */
  sessionId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
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
  /**
   * Completed tool calls (and their results) from earlier in THIS turn's
   * planAction<->runTool loop -- fed back to `deps.actionPlanner.plan` so it
   * can decide its next step from what a prior tool actually returned (e.g.
   * fetch a page a prior web-search call surfaced), instead of getting only
   * one tool call per turn. Reset per turn (never persisted across turns).
   */
  actionHistory: Annotation<ToolCallRecord[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),
  /**
   * The most recent decision `planAction` made -- distinguishes "just chose
   * to call a NEW tool" (route to runTool) from "decided to stop" (either
   * `respond`, ending the turn with the planner's own synthesized text, or
   * `finish`, ending the turn with the last tool's result verbatim via
   * composeResponse) from a plain routing check on `selectedTool` alone,
   * which stays populated across loop iterations and can't tell those apart.
   */
  plannedAction: Annotation<"respond" | "call_tool" | "finish" | undefined>({
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
   * all and `noMatchFallback` handled the turn instead — either a relevance-
   * gated direct tool call (selectFallbackTool) or a bare best-effort LLM
   * answer. Read by `runTool` to append a self-improvement suggestion onto
   * the tool's result (the bare-answer case already has the suggestion
   * appended in noMatchFallback itself). Never true for the `bareAnswer`
   * short-circuit below (docs/adr/0019) — that path never attempted a
   * catalog search, so there is nothing to suggest turning into a skill.
   */
  wasFallback: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
  /**
   * Result of `checkNeedsCapability` (docs/adr/0019): whether this request
   * plausibly needs a specialized skill/tool/agent, as opposed to being
   * answerable directly from general conversation. Defaults to `true` so any
   * path that never reaches that node (active skill/agent continuation) is
   * unaffected. `false` routes straight to `bareAnswer`, skipping
   * `retrieveSkills`/`retrieveAgents`/`selectDelegate` entirely.
   */
  needsCapability: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => true,
  }),
  /**
   * The identity-link analogue of `activeAgentId`/`activeAgentRunId` — a
   * delegation attempt that's paused on a one-time OAuth Device Flow
   * authorization has no live AgentRun/NATS channel yet, unlike an in-flight
   * agent question (`checkActiveAgentRun`), so it needs its own
   * session-carried pending state. Set by `delegateToAgent` when it starts a
   * fresh device-flow attempt; consumed (and cleared) by
   * `checkPendingIdentityLink` on the NEXT turn once the caller has had a
   * chance to authorize (or the attempt times out/is denied).
   */
  pendingIdentityLink: Annotation<
    | {
        agentId: string;
        provider: string;
        flow: "device" | "authcode";
        deviceCode?: string;
        expiresAt: number;
        /**
         * The turn's original request, captured when the pause started, so
         * resuming re-delegates with the ORIGINAL goal instead of whatever
         * throwaway text (e.g. "done") the caller happened to send on the
         * turn that finally noticed the link completed. Optional so a
         * session already mid-pause before this field existed still falls
         * back to the old (buggy but non-crashing) behavior rather than
         * erroring.
         */
        request?: string;
      }
    | undefined
  >({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * True when THIS turn ended still waiting on the caller to complete a
   * pending device-flow authorization (`checkPendingIdentityLink` polled
   * "pending" and the attempt hasn't expired yet) — the turn's `result` is a
   * plain "still waiting" message, not a real delegation outcome, so the
   * server persists `pendingIdentityLink` rather than clearing it the way it
   * would for an ordinary terminal turn.
   */
  identityLinkPending: Annotation<boolean>({
    reducer: (_current, update) => update,
    default: () => false,
  }),
  /**
   * Per-turn override of which OAuth flow `delegateToAgent` starts when this
   * caller hasn't linked their identity yet. Absent means the default
   * ("authcode") applies at the point of use -- ordinary Open WebUI chat
   * turns never set this, so they always get the browser-redirect flow. An
   * explicit direct `/invoke` caller (e.g. integration-gateway's own headless
   * GitHub-issue relay, which has no browser to redirect) can force
   * `"device"` instead.
   */
  identityLinkFlow: Annotation<"device" | "authcode" | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Open WebUI's per-request signed `X-OpenWebUI-User-Jwt` header, if the
   * caller sent one. When present (and `deps.forwardedUserIdentityResolver`
   * is configured), `resolveIdentity` resolves the caller's identity from
   * this instead of `authToken` -- Open WebUI's `authToken` is a single
   * static value shared by every one of its users, so resolving identity
   * from it alone would collapse every human into one shared subject.
   */
  forwardedUserToken: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /**
   * Id of a Skill CR to dispatch to directly, set by the server when
   * `/invoke`'s optional `event` field matched an `IntegrationRoute` CR —
   * consumed by `checkIntegrationRoute` to bypass RAG skill retrieval for
   * this turn. Absent for every ordinary conversational turn.
   */
  forcedSkillId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
  /** Id of an Agent CR to dispatch to directly — see `forcedSkillId`. */
  forcedAgentId: Annotation<string | undefined>({
    reducer: (_current, update) => update,
    default: () => undefined,
  }),
});

export type AgentState = typeof AgentStateAnnotation.State;

export interface AgentGraphDeps {
  identityResolver: IdentityResolver;
  /**
   * Resolves identity from Open WebUI's per-request signed
   * `X-OpenWebUI-User-Jwt` header (`OpenWebUiForwardedUserResolver`) rather
   * than its shared static `authToken`. Optional: absent -> `resolveIdentity`
   * always falls back to `identityResolver.resolve(state.authToken)`, the
   * pre-existing shared-subject behavior for deployments that haven't
   * configured `AGENT_OPENWEBUI_USER_JWT_SECRET`.
   */
  forwardedUserIdentityResolver?: IdentityResolver;
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
  /** Creates the AgentRun CR the core-controller reconciles into a hardened Job. */
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
   * Max candidate tools retrieved when attempting a direct fallback tool call
   * (selectFallbackTool) for a turn matching no Skill/Agent. Mirrors
   * skillTopK/agentTopK.
   */
  fallbackToolTopK?: number;
  /**
   * Narrow, skeptical per-candidate relevance gate for the fallback tool-fit
   * path — rejects tools that only surfaced via loose embedding/keyword
   * overlap (e.g. "create a recipe" vs. a tool described as "create a
   * repository") before they're ever handed to the action planner.
   */
  toolFitChecker: ToolFitChecker;
  /**
   * The true last resort (noMatchFallback): a plain conversational LLM
   * answer, called only when NEITHER a Skill/Agent match NOR a fallback tool
   * fit was found. Deliberately not a hardcoded fallback agent — delegating
   * an unrelated request to a general-purpose agent (e.g. a coding agent)
   * caused it to take real, unwanted side effects (opening a GitHub repo/PR
   * for a cooking-recipe request) rather than just answering in chat.
   */
  bestEffortResponder: BestEffortResponder;
  /**
   * Gates catalog retrieval (docs/adr/0019): asked once per turn, after
   * session-continuity checks and before `retrieveSkills`/`retrieveAgents`,
   * whether the request plausibly needs a specialized capability at all. A
   * "no" short-circuits straight to a plain conversational answer (no RAG
   * search, no self-improvement suggestion) via the `bareAnswer` node.
   */
  capabilityNeedChecker: CapabilityNeedChecker;
  /**
   * Client for apps/integration-gateway's identity-link API (OAuth Device
   * Flow) — lets `delegateToAgent`/`checkPendingIdentityLink` resolve a
   * per-caller GitHub token instead of a shared static credential. Optional:
   * absent means no Agent in the catalog is expected to declare
   * `identityProviders`; if one does anyway, `delegateToAgent` fails with a
   * clear `state.error` rather than silently skipping the identity check.
   */
  identityLinkGateway?: IdentityLinkPort;
}

/**
 * Maps an identity-linked provider (Agent.identityProviders, e.g. "github")
 * to the env var name its linked token is injected as (AgentLaunchOptions'
 * secretEnv, agentrun-launcher.ts). Phase A supports exactly one provider.
 */
const PROVIDER_ENV_VAR: Record<string, string> = { github: "GITHUB_TOKEN" };

/**
 * Caps how many tool calls a skill's planAction<->runTool loop may chain in a
 * single turn (docs/adr/0008 update: multi-step tool use) -- generous enough
 * for a realistic research chain (e.g. search, then fetch two candidate
 * pages) while bounding the worst case of a planner that never settles.
 */
const MAX_TOOL_STEPS = 4;

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

function appendSelfImprovementSuggestion(message: string): string {
  return `${message}${SELF_IMPROVEMENT_FOOTER}`;
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
  "would need multiple tools or steps to satisfy, decline (respond) rather than force a guess; this request",
  "will get a plain best-effort answer instead if no tool is called.",
].join(" ");

/**
 * Best-effort direct tool call for a request that matched no Skill or Agent
 * (graph.ts's selectDelegate). Retrieves top-K candidates from the FULL tool
 * catalog by embedding similarity, then re-checks each with `toolFitChecker`
 * — a narrower, more skeptical judgment than the embedding score alone,
 * since similarity search surfaces loose keyword-overlap matches (e.g. a
 * request to "create a recipe" scoring against a tool described as
 * "create...a repository") that are not actually relevant. Only tools that
 * pass this check are ever handed to the action planner for a real call/args
 * decision. Returns undefined when nothing passes (or none are visible to
 * this caller) — the caller falls through to noMatchFallback's bare LLM
 * response in that case.
 */
async function selectFallbackTool(
  state: AgentState,
  deps: AgentGraphDeps,
): Promise<{ tool: ToolDescriptor; toolArgs: string; toolInstanceKey?: string } | undefined> {
  if (!state.identity) return undefined;
  const candidates = await deps.vectorStore.query(state.request, { callerRoles: state.identity.roles }, deps.fallbackToolTopK ?? 3);
  if (candidates.length === 0) return undefined;
  const fitFlags = await Promise.all(candidates.map((c) => deps.toolFitChecker.fits(state.request, c.tool)));
  const tools = candidates.filter((_, i) => fitFlags[i]).map((c) => c.tool);
  if (tools.length === 0) return undefined;
  const syntheticSkill: SkillDescriptor = {
    id: "__fallback_tool__",
    name: "Fallback tool selection",
    description: "",
    markdown: FALLBACK_TOOL_MARKDOWN,
    toolIds: tools.map((t) => t.id),
    agentIds: [],
  };
  const planned = await deps.actionPlanner.plan(state.request, syntheticSkill, tools);
  if (planned.action !== "call_tool") return undefined;
  const tool = tools.find((t) => t.id === planned.toolId);
  if (!tool) return undefined;
  return { tool, toolArgs: planned.toolArgs, ...(planned.toolInstanceKey ? { toolInstanceKey: planned.toolInstanceKey } : {}) };
}

/**
 * Calls `bestEffortResponder` for the raw request, streaming deltas through
 * `progressListener` (as "agent-text" content, the same convention
 * `composeAgentTurnMessage` uses) when one is attached. Shared by
 * `noMatchFallback`'s bare-answer branch and the `bareAnswer` node
 * (docs/adr/0019) — the two differ only in whether the self-improvement
 * footer gets appended, not in how the model is called.
 */
async function callBestEffort(state: AgentState, deps: AgentGraphDeps): Promise<string> {
  const onToken = state.progressListener
    ? (delta: string) => state.progressListener!("agent-text", delta)
    : undefined;
  return onToken ? deps.bestEffortResponder.respond(state.request, onToken) : deps.bestEffortResponder.respond(state.request);
}

/**
 * The full no-match cascade for `selectDelegate`: try a direct single-tool
 * fit first (relevance-gated, deterministic), and if nothing passes, the
 * request gets a plain conversational answer from `bestEffortResponder` —
 * never a hardcoded fallback agent (see that interface's doc comment for
 * why). Shared by every "nothing matched" branch in selectDelegate so the
 * cascade is applied uniformly regardless of whether agent delegation (NATS)
 * is configured.
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
  // Streaming callers watch the response go by live as "agent-text" content
  // deltas (server.ts), so the final `result` need only carry the footer --
  // duplicating the body here would repeat the whole answer in the chat, the
  // same rule composeAgentTurnMessage applies via dropStreamedNarrative.
  const response = await callBestEffort(state, deps);
  const result = state.progressListener ? SELF_IMPROVEMENT_FOOTER : appendSelfImprovementSuggestion(response);
  return { result, wasFallback: true };
}

/** Builds and compiles the LangGraph.js agent graph (docs/adr/0008, superseding the earlier flat tool-RAG flow). */
export function buildAgentGraph(deps: AgentGraphDeps) {
  const graph = new StateGraph(AgentStateAnnotation)
    .addNode("resolveIdentity", async (state) => {
      // Prefer Open WebUI's per-request signed user JWT over the shared
      // static authToken when available -- authToken is one value shared by
      // every Open WebUI user, so resolving identity from it alone would
      // collapse every human into one shared subject (see
      // OpenWebUiForwardedUserResolver).
      const identity =
        state.forwardedUserToken && deps.forwardedUserIdentityResolver
          ? await deps.forwardedUserIdentityResolver.resolve(state.forwardedUserToken)
          : await deps.identityResolver.resolve(state.authToken);
      if (!identity) {
        return { error: "unauthorized: could not resolve caller identity" };
      }
      return { identity };
    })
    .addNode("checkIntegrationRoute", async (state) => {
      // Deterministic dispatch for a turn whose intent is already
      // unambiguous (e.g. a GitHub issue assigned to the bot): the server
      // set `forcedSkillId`/`forcedAgentId` when `/invoke`'s `event` field
      // matched an IntegrationRoute CR. Re-fetch under the caller's CURRENT
      // roles (same RBAC discipline as checkActiveSkill/checkPendingIdentityLink)
      // and resolve straight to that target, skipping RAG retrieval entirely.
      // A miss (ref gone, roles revoked, neither id set) is never an error —
      // it just falls through to ordinary skill-continuity/retrieval.
      if (!state.identity) return {};
      if (state.forcedSkillId) {
        const [skill] = await deps.skillStore.getByIds([state.forcedSkillId], {
          callerRoles: state.identity.roles,
        });
        if (skill) return { selectedSkill: skill };
      }
      if (state.forcedAgentId && deps.agentStore) {
        const [found] = await deps.agentStore.getByIds([state.forcedAgentId], {
          callerRoles: state.identity.roles,
        });
        if (found) return { selectedAgent: found.agent };
      }
      return {};
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
    .addNode("checkPendingIdentityLink", async (state) => {
      // Identity-link continuation, run right after resolveIdentity and
      // before any skill/agent-run continuity check (mirrors
      // checkActiveSkill/checkActiveAgentRun's own discipline): if the LAST
      // turn paused on a one-time device-flow authorization, see whether the
      // caller has completed it yet. Every miss (no session, subject
      // mismatch, gateway/agentStore not configured) falls through to
      // ordinary retrieval/selection -- a miss is never an error.
      if (!state.identity || !state.pendingIdentityLink) return {};
      if (state.sessionSubject !== state.identity.subject) return {};
      if (!deps.identityLinkGateway || !deps.agentStore) return {};
      const pending = state.pendingIdentityLink;

      // Resolve "is this pending link now complete, still pending, or
      // expired/denied" per flow -- device polls GitHub's device-code
      // endpoint; authcode has nothing analogous to poll against (the
      // browser redirect completes out-of-band via integration-gateway's own
      // callback route), so it just checks whether a token has landed yet.
      const status =
        pending.flow === "device"
          ? await deps.identityLinkGateway.poll(pending.provider, state.identity.subject, pending.deviceCode!)
          : (await deps.identityLinkGateway.getToken(pending.provider, state.identity.subject))
            ? "complete"
            : Date.now() < pending.expiresAt
              ? "pending"
              : "expired";

      if (status === "pending" && Date.now() < pending.expiresAt) {
        return {
          identityLinkPending: true,
          result:
            pending.flow === "device"
              ? "Still waiting for you to authorize GitHub access. Visit the link and enter the code you were given, then send any message to continue."
              : "Still waiting for you to authorize GitHub access. Visit the link and complete it in your browser, then send any message to continue.",
        };
      }
      if (status === "pending" || status === "expired" || status === "denied") {
        // Link attempt is over (timed out or explicitly failed) -- clear it
        // and let this turn fall through to ordinary retrieval/selection,
        // which will re-detect the missing link and start a FRESH
        // device-flow attempt in delegateToAgent if the same/another
        // identity-requiring agent is chosen again.
        return { pendingIdentityLink: undefined };
      }
      // status === "complete": re-fetch the agent (RBAC re-check, same
      // discipline as checkActiveAgentRun) and resume straight into
      // delegation with it.
      const [found] = await deps.agentStore.getByIds([pending.agentId], { callerRoles: state.identity.roles });
      if (!found) return { pendingIdentityLink: undefined }; // agent gone/revoked -- fall through to fresh selection
      return {
        selectedAgent: found.agent,
        pendingIdentityLink: undefined,
        // Restore the ORIGINAL request captured when the pause started, so
        // delegateToAgent re-delegates with THAT goal -- not whatever text
        // this resuming turn happens to carry (e.g. a plain "done" sent
        // just to nudge the conversation along). Absent only for a session
        // that paused before this field existed, in which case state.request
        // (this turn's text) is the best available fallback, same as before.
        ...(pending.request !== undefined ? { request: pending.request } : {}),
      };
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
    .addNode("checkNeedsCapability", async (state) => {
      // Cheap classifier gate (docs/adr/0019) run once every session-
      // continuity check has missed: decides whether this turn plausibly
      // needs a specialized skill/tool/agent at all, before spending an
      // embedding + RAG round trip over the catalogs to find out the hard
      // way. "No" is never an error -- see `bareAnswer` below.
      const needsCapability = await deps.capabilityNeedChecker.needsCapability(state.request);
      return { needsCapability };
    })
    .addNode("bareAnswer", async (state) => {
      // A plain conversational answer for a request that was never expected
      // to need a skill/tool/agent (docs/adr/0019) -- unlike
      // `noMatchFallback`'s bare-answer branch, no catalog search was ever
      // attempted here, so `wasFallback` stays false and no
      // self-improvement suggestion is appended.
      const response = await callBestEffort(state, deps);
      return { result: state.progressListener ? "" : response };
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

      // TEMPORARY diagnostic for the "launched with no GITHUB_TOKEN despite
      // a linked identity" investigation -- remove once root-caused. Logs
      // exactly what this call sees at the identity-gate decision point,
      // never the token value itself.
      console.log(
        "[identity-gate-debug] delegateToAgent",
        JSON.stringify({
          agentId: agent.id,
          identityProviders: agent.identityProviders,
          hasIdentityLinkGateway: Boolean(deps.identityLinkGateway),
          subject: state.identity.subject,
          roles: state.identity.roles,
          hasProgressListener: Boolean(state.progressListener),
        }),
      );

      // Per-caller identity gate (replaces the old shared static credential
      // for any Agent that declares `identityProviders`): the FIRST time this
      // caller delegates to such an agent, they must link their own GitHub
      // account (one-time OAuth Device Flow) before a launch is even
      // attempted. Phase A supports exactly one provider end-to-end
      // ("github" -> GITHUB_TOKEN); the loop below is written to extend to
      // multiple providers later without reshaping state.
      let identitySecretEnv: { name: string; value: string }[] | undefined;
      if (agent.identityProviders && agent.identityProviders.length > 0) {
        if (!deps.identityLinkGateway) {
          return {
            error: `agent ${agent.id} requires identity providers (${agent.identityProviders.join(", ")}) but no identity-link gateway is configured`,
          };
        }
        const provider = agent.identityProviders[0]!;
        let existing = await deps.identityLinkGateway.getToken(provider, state.identity.subject);
        console.log(
          "[identity-gate-debug] getToken",
          JSON.stringify({ provider, subject: state.identity.subject, found: Boolean(existing) }),
        );
        if (!existing) {
          // Ordinary Open WebUI chat turns never set `identityLinkFlow`, so
          // they default to the browser-redirect authcode flow; a headless
          // direct `/invoke` caller (e.g. integration-gateway's own
          // GitHub-issue relay) can force the device flow instead, since it
          // has no browser to redirect.
          const flow = state.identityLinkFlow ?? "authcode";
          const started = await deps.identityLinkGateway.start(provider, state.identity.subject, flow);
          const linkUrlText =
            started.flow === "device"
              ? `[link your GitHub account](${started.verificationUri}) and enter code \`${started.userCode}\``
              : `[link your GitHub account](${started.authorizeUrl})`;

          // Block for up to this flow's own expiry waiting for the caller to
          // complete authorization -- `waitForCompletion` blocks on the
          // gateway's own Redis-backed wait (not local polling) purely by
          // (provider, subject), so it resolves the moment EITHER flow lands
          // a token, regardless of which one was started. This is what lets
          // ANY caller resume automatically without a follow-up message, not
          // just SSE-streaming ones: `/invoke`'s own async accept/poll
          // contract (ADR 0006) already tolerates a graph run taking several
          // minutes, so a fire-and-forget caller (e.g. integration-gateway's
          // GitHub relay, always device flow) benefits from this exactly the
          // same way a streaming chat turn does. `progressListener`, when
          // present, only adds narration while waiting; it does not gate
          // whether we wait at all.
          state.progressListener?.("identity-link", `To continue, please ${linkUrlText}. This is a one-time step — I'll continue automatically once you finish.`);
          existing = await deps.identityLinkGateway.waitForCompletion?.(
            provider,
            state.identity.subject,
            started.expiresInSeconds * 1000,
          );

          if (!existing) {
            return {
              result: `To continue, please ${linkUrlText}. This is a one-time step -- send any message once you're done.`,
              pendingIdentityLink: {
                agentId: agent.id,
                provider,
                flow: started.flow,
                ...(started.flow === "device" ? { deviceCode: started.deviceCode } : {}),
                expiresAt: Date.now() + started.expiresInSeconds * 1000,
                // Captured so the eventual resume (checkPendingIdentityLink)
                // re-delegates with THIS goal, not whatever text the turn
                // that finally notices completion happens to carry.
                request: state.request,
              },
              identityLinkPending: true,
            };
          }
        }
        const envVarName = PROVIDER_ENV_VAR[provider];
        if (!envVarName) {
          return { error: `agent ${agent.id} declares unsupported identity provider "${provider}"` };
        }
        identitySecretEnv = [{ name: envVarName, value: existing.token }];
      }
      console.log(
        "[identity-gate-debug] pre-launch",
        JSON.stringify({ agentId: agent.id, hasIdentitySecretEnv: Boolean(identitySecretEnv) }),
      );

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
          ...(deps.natsUrl ? { natsUrl: deps.natsUrl, natsSubject: `callbacks.${runId}` } : {}),
          ...(identitySecretEnv ? { secretEnv: identitySecretEnv } : {}),
          ...(state.sessionId ? { sessionId: state.sessionId } : {}),
        });
        const reply = await awaitReply;
        const message = composeAgentTurnMessage(state, reply);
        return {
          agentRunId: runId,
          agentAwaitingReply: !reply.final,
          result: message,
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
      const { toolIds, agentIds } = state.selectedSkill;
      // Respond-only skill (no toolIds/agentIds, ADR 0011/0021): nothing to
      // load and nothing to authorize -- the planner can only choose "respond".
      if (toolIds.length === 0 && agentIds.length === 0) {
        return { skillTools: [] };
      }

      if (agentIds.length > 0 && !deps.agentStore) {
        // Same precondition an agent-backed Tool's dispatch already requires
        // (runTool below) -- a Skill.agentRefs (ADR 0021) is equally
        // meaningless without agent delegation configured (NATS).
        return { error: `skill ${state.selectedSkill.id} declares agentRefs but agent delegation is not configured` };
      }

      const [toolResults, agentResults] = await Promise.all([
        toolIds.length > 0 ? deps.vectorStore.getByIds(toolIds, { callerRoles: state.identity.roles }) : [],
        agentIds.length > 0 && deps.agentStore
          ? deps.agentStore.getByIds(agentIds, { callerRoles: state.identity.roles })
          : [],
      ]);
      // Adapt each resolved Agent into the same ToolDescriptor shape an
      // agent-backed Tool (Tool.spec.agentRef) already produces (ADR 0021) --
      // runTool/action-planner dispatch on `agentRunTemplate` alone and don't
      // need to know whether it came from a Tool wrapper or a Skill's own
      // agentRefs.
      const skillTools: ToolDescriptor[] = [
        ...toolResults.map((r) => r.tool),
        ...agentResults.map((r) => ({
          id: r.agent.id,
          name: r.agent.name,
          description: r.agent.description,
          allowedRoles: r.agent.allowedRoles,
          tier: r.agent.tier,
          agentRunTemplate: r.agent.agentRunTemplate,
          identityProviders: r.agent.identityProviders,
        })),
      ];
      if (skillTools.length === 0) {
        // Should be unreachable now that skill visibility is derived from
        // tool/agent RBAC (ADR 0011/0021) -- kept as the fail-closed backstop
        // for index drift (e.g. a Tool/Agent CR deleted after startup indexing).
        return { error: "skill has no usable tools/agents for this caller" };
      }
      return { skillTools };
    })
    .addNode("planAction", async (state) => {
      if (!state.selectedSkill) {
        return { error: "no skill selected" };
      }
      // Bound the loop (docs/adr/0008 update: multi-step tool use) so a
      // planner that never settles can't run forever -- finish with the
      // last tool's result rather than erroring, since a genuine answer is
      // already in hand.
      if (state.actionHistory.length >= MAX_TOOL_STEPS) {
        return { plannedAction: "finish" };
      }
      const planned = await deps.actionPlanner.plan(state.request, state.selectedSkill, state.skillTools, state.actionHistory);
      if (planned.action === "finish") {
        return { plannedAction: "finish" };
      }
      if (planned.action === "respond") {
        return { result: planned.response, plannedAction: "respond" };
      }
      const tool = state.skillTools.find((t) => t.id === planned.toolId);
      if (!tool) {
        return { error: "planner selected a tool outside the skill's scope" };
      }
      const last = state.actionHistory[state.actionHistory.length - 1];
      if (last && last.toolId === planned.toolId && last.toolArgs === planned.toolArgs) {
        // Guard against a stuck loop re-issuing an identical call: treat a
        // verbatim repeat as "done", same as an explicit finish.
        return { plannedAction: "finish" };
      }
      return {
        selectedTool: tool,
        toolArgs: planned.toolArgs,
        toolInstanceKey: planned.toolInstanceKey,
        plannedAction: "call_tool",
      };
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
        // ToolRun Job. Lets a Skill's toolRefs/agentRefs reach a full agent
        // loop (e.g. a coding agent that opens PRs) via the ordinary
        // tool-call path.
        if (!deps.agentRunLauncher || !deps.agentChannel || !deps.callbackSecretRef) {
          return { error: `tool ${tool.id} is agent-backed but agent delegation is not configured` };
        }
        // Same per-caller identity gate as delegateToAgent (ADR 0022) --
        // required here too now that an identity-gated Agent's static
        // secretEnv is stripped regardless of which path reaches it. v1
        // scope cut: unlike delegateToAgent, this path never STARTS a fresh
        // device-flow/authcode link -- there's no session slot analogous to
        // pendingIdentityLink for a paused tool call, only for a paused
        // agent delegation. A caller must link once via direct chat
        // delegation to the same agent before a Skill can reach it here.
        let identitySecretEnv: { name: string; value: string }[] | undefined;
        if (tool.identityProviders && tool.identityProviders.length > 0) {
          if (!deps.identityLinkGateway || !state.identity) {
            return {
              error: `tool ${tool.id} requires identity providers (${tool.identityProviders.join(", ")}) but no identity-link gateway is configured`,
            };
          }
          const provider = tool.identityProviders[0]!;
          const existing = await deps.identityLinkGateway.getToken(provider, state.identity.subject);
          if (!existing) {
            return {
              error: `tool ${tool.id} requires linking your ${provider} account first -- start a direct conversation with this agent to link it, then retry`,
            };
          }
          const envVarName = PROVIDER_ENV_VAR[provider];
          if (!envVarName) {
            return { error: `tool ${tool.id} declares unsupported identity provider "${provider}"` };
          }
          identitySecretEnv = [{ name: envVarName, value: existing.token }];
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
            ...(deps.natsUrl ? { natsUrl: deps.natsUrl, natsSubject: `callbacks.${runId}` } : {}),
            ...(identitySecretEnv ? { secretEnv: identitySecretEnv } : {}),
            ...(state.sessionId ? { sessionId: state.sessionId } : {}),
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
            actionHistory: [...state.actionHistory, { toolId: tool.id, toolArgs: input, result: text }],
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
        event = await deps.localToolExecutor.run(tool, input, state.sessionId);
        jobId = event.job_id;
      } else if (tool.jobTemplate) {
        // Container tool (ADR 0010): create a ToolRun CR — the Go
        // core-controller reconciles it into a hardened Job. The orchestrator
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
              ...(state.sessionId ? { sessionId: state.sessionId } : {}),
            });
          } else {
            // HTTP callback mode (backward-compatible default).
            const callbackUrl = `${deps.callbackBaseUrl!}/callback/${jobId}`;
            await deps.containerToolLauncher.launch(tool.jobTemplate, {
              args: [input],
              callbackUrl,
              callbackSecret: deps.callbackSecret!,
              ...(state.sessionId ? { sessionId: state.sessionId } : {}),
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
          actionHistory: [...state.actionHistory, { toolId: tool.id, toolArgs: input, result: text }],
        };
      }
      // The tool output is surfaced to the user verbatim; any follow-up
      // narration is added by the composeResponse node (docs/adr/0015), not
      // hard-coded here. Structured results are stringified only for the
      // planner's own benefit (`actionHistory`'s prompt context) -- `result`
      // itself carries the real object through untouched.
      return {
        jobId,
        result: event.result,
        actionHistory: [...state.actionHistory, { toolId: tool.id, toolArgs: input, result: JSON.stringify(event.result) }],
      };
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
      // the string path. Also a no-op when the planner's last decision was
      // "respond" rather than "finish" -- that means the visible text is
      // already the planner's own synthesized final answer (e.g. after a
      // multi-step search-then-answer chain), not a verbatim tool result to
      // narrate around.
      if (!state.selectedSkill || !state.selectedTool || state.plannedAction !== "finish" || typeof state.result !== "string") {
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
    .addConditionalEdges("resolveIdentity", afterOrEnd("checkIntegrationRoute"))
    // A matched IntegrationRoute resolves straight to its target -> skip
    // straight to delegation/tool-loading; a miss (no event, no match, ref
    // gone) falls through to the ordinary identity-link/skill-continuity
    // chain exactly as before this node existed.
    .addConditionalEdges("checkIntegrationRoute", (state) =>
      state.error
        ? END
        : state.selectedAgent
          ? "delegateToAgent"
          : state.selectedSkill
            ? "loadSkillTools"
            : "checkPendingIdentityLink",
    )
    // A pending device-flow link either just completed (an agent was
    // re-selected -> resume straight into delegateToAgent), is still being
    // waited on (identityLinkPending -> END, same "still waiting" result as
    // last turn), or missed entirely (no pending link, or it just
    // expired/was cleared) -> fall through to ordinary skill continuity.
    .addConditionalEdges("checkPendingIdentityLink", (state) =>
      state.error ? END : state.selectedAgent ? "delegateToAgent" : state.identityLinkPending ? END : "checkActiveSkill",
    )
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
    .addConditionalEdges("checkActiveAgentRun", (state) => (state.error || state.agentRunId ? END : "checkNeedsCapability"))
    // A "no" (docs/adr/0019) skips catalog retrieval entirely and answers
    // directly; a "yes" (or classifier error) proceeds exactly as before.
    .addConditionalEdges("checkNeedsCapability", (state) =>
      state.error ? END : state.needsCapability ? "retrieveSkills" : "bareAnswer",
    )
    .addEdge("bareAnswer", END)
    .addConditionalEdges("retrieveSkills", afterOrEnd("retrieveAgents"))
    .addConditionalEdges("retrieveAgents", afterOrEnd("selectDelegate"))
    // selectDelegate branches five ways: error -> END, a skill was picked ->
    // loadSkillTools (existing flow, unchanged), an agent was picked (a real
    // DelegateSelector match — never a hardcoded fallback) -> delegateToAgent,
    // a tool was picked directly with no skill (the fallback tool-fit path,
    // noMatchFallback) -> runTool skipping loadSkillTools/planAction, or
    // noMatchFallback already produced a bare best-effort LLM answer (result
    // set, nothing else selected) -> END, nothing left to do.
    .addConditionalEdges("selectDelegate", (state) => {
      if (state.error) return END;
      if (state.selectedAgent) return "delegateToAgent";
      if (state.selectedTool) return "runTool";
      if (state.result !== undefined) return END;
      return "loadSkillTools";
    })
    // Delegation is always terminal for THIS graph invocation — whether the
    // agent asked a question, gave its final reply, or failed. A follow-up
    // user turn is a NEW invocation that re-enters via checkActiveAgentRun.
    .addEdge("delegateToAgent", END)
    .addConditionalEdges("loadSkillTools", afterOrEnd("planAction"))
    // planAction branches three ways: error -> END, "call_tool" -> runTool
    // (chain another tool call), "finish" -> composeResponse (show the last
    // tool's result verbatim, with optional narration), "respond" -> END
    // (the planner's own synthesized final text, already complete).
    .addConditionalEdges("planAction", (state) => {
      if (state.error) return END;
      if (state.plannedAction === "call_tool") return "runTool";
      if (state.plannedAction === "finish") return "composeResponse";
      return END;
    })
    // A failed/empty tool run ends the turn. A successful skill-driven call
    // (selectedSkill set) loops back to planAction so the skill can chain
    // another tool call or decide it's done (docs/adr/0008 update: multi-step
    // tool use) -- bounded by MAX_TOOL_STEPS there. A successful FALLBACK
    // tool call (no skill selected -- selectFallbackTool/noMatchFallback,
    // which never re-plans) goes straight to composeResponse as before.
    .addConditionalEdges("runTool", (state) => {
      if (state.error || state.result === undefined) return END;
      return state.selectedSkill ? "planAction" : "composeResponse";
    })
    .addEdge("composeResponse", END);

  return graph.compile();
}
