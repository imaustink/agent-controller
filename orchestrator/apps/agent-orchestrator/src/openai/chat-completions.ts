import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { PendingToolCall, PriorCallerToolCall } from "../caller-tools/types.js";

/**
 * Translation layer between the OpenAI Chat Completions wire format and the
 * agent graph's own request/state shape (ADR 0006/0007). Nothing here talks
 * to the graph directly — it only builds/parses the JSON and SSE shapes so
 * `server.ts` can stay focused on HTTP routing.
 */
export const MODEL_ID = "agent-orchestrator";

interface ChatMessage {
  role?: unknown;
  content?: unknown;
  /** Present on an assistant message that asked the client to run a tool (docs/adr/0035). */
  tool_calls?: unknown;
  /** Present on a `role: "tool"` message, correlating it back to that request. */
  tool_call_id?: unknown;
}

export function listModelsResponse(): unknown {
  return {
    object: "list",
    data: [{ id: MODEL_ID, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "controller-agent" }],
  };
}

/** Finds the index of the most recent message with the given `role`, searching backward from `before`. */
function findLastMessageIndex(messages: ChatMessage[], role: string, before: number = messages.length): number {
  for (let i = before - 1; i >= 0; i--) {
    const message = messages[i];
    if (
      message &&
      typeof message === "object" &&
      message.role === role &&
      typeof message.content === "string" &&
      message.content.trim() !== ""
    ) {
      return i;
    }
  }
  return -1;
}

/** What {@link buildAgentRequest} extracts from an incoming `messages` array. */
export interface AgentRequest {
  /** The request string the graph sees, including any folded `<conversation_history>`. */
  request: string;
  /**
   * Tool calls the CALLER already executed for the exchange in flight, paired
   * with their results (docs/adr/0035). Seeds `AgentState.actionHistory`; empty
   * for every ordinary turn.
   */
  priorToolCalls: PriorCallerToolCall[];
}

/** Most recent prior messages folded into the request (see {@link buildAgentRequest}). */
const HISTORY_MAX_MESSAGES = 8;
/** Total character budget for folded history; oldest messages dropped first when exceeded. */
const HISTORY_MAX_CHARS = 24_000;

/**
 * Appended to a `noMatchFallback` reply (graph.ts) so the user knows a turn
 * was handled ad-hoc and can ask for a permanent skill. Exported (rather than
 * kept private to graph.ts) so {@link buildAgentRequest} can strip it back
 * out of a folded assistant message below.
 */
export const SELF_IMPROVEMENT_FOOTER =
  "\n\n---\nNo existing skill or agent matched this request, so it was handled ad-hoc. Ask me to run the self-improvement skill if you'd like a permanent skill added for this next time.";

/**
 * Strips a trailing {@link SELF_IMPROVEMENT_FOOTER} from a folded assistant
 * message. This footer is a UI hint for the human ("no skill matched, want
 * one added?"), not semantic content — but left in, it re-enters the next
 * turn's `<conversation_history>` verbatim, and its very "no existing skill
 * or agent matched this request" wording biases the next turn's
 * skill/agent/tool selection calls (all of which see the full folded
 * history) toward repeating "no match" even when the new turn's request
 * plainly fits a real skill. Stripping it keeps the selectors judging the
 * actual conversation content instead of the orchestrator's own prior
 * fallback verdict.
 */
function stripSelfImprovementFooter(content: string): string {
  return content.endsWith(SELF_IMPROVEMENT_FOOTER) ? content.slice(0, -SELF_IMPROVEMENT_FOOTER.length) : content;
}

/**
 * Builds the actual request text sent to the agent graph. The graph itself
 * is stateless per-turn (docs/adr/0008) — it only ever sees a single
 * `request` string — but standard OpenAI-style chat clients (Open WebUI et
 * al.) always send the FULL conversation, not just the new turn.
 *
 * A bounded window of the prior conversation (both `user` and `assistant`
 * turns) is folded in ahead of the new user message, wrapped in a
 * `<conversation_history>` tag skills can key off of. Earlier versions
 * folded only the single most recent assistant message
 * (`<previous_assistant_response>`), which silently discarded content the
 * USER had supplied in an earlier turn — e.g. a recipe Markdown pasted by
 * the user (rather than extracted by a tool) was invisible two turns later
 * when they said "publish it", forcing a re-paste. Both roles matter:
 * in-progress artifacts can originate from either side of the conversation.
 *
 * The folded history is still just data, not instructions — see the skill
 * markdown's untrusted-data framing. It's bounded (message count + char
 * budget, oldest dropped first) so a long chat can't grow the prompt — and
 * the RAG embedding of it — without limit.
 *
 * Tool calls the client already executed are NOT folded into that prose. They're
 * returned separately as {@link AgentRequest.priorToolCalls} (docs/adr/0035 §1),
 * so the planner reads them as structured tool results rather than as
 * conversation text.
 */
export function buildAgentRequest(messages: unknown): AgentRequest | undefined {
  if (!Array.isArray(messages)) return undefined;
  const arr = messages as ChatMessage[];
  const userIdx = findLastMessageIndex(arr, "user");
  if (userIdx === -1) return undefined;
  const userContent = arr[userIdx]!.content as string;
  // Tool calls the CLIENT already executed for us, lifted out as structured
  // history rather than folded into the prose below (docs/adr/0035 §1).
  const priorToolCalls = collectPriorToolCalls(arr, userIdx);

  // Collect prior user/assistant turns, newest-last, bounded by count.
  const prior: { role: string; content: string }[] = [];
  for (let i = userIdx - 1; i >= 0 && prior.length < HISTORY_MAX_MESSAGES; i--) {
    const message = arr[i];
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string" || message.content.trim() === "") continue;
    const content = message.role === "assistant" ? stripSelfImprovementFooter(message.content) : message.content;
    prior.unshift({ role: message.role, content });
  }
  // Enforce the char budget by dropping oldest first.
  let total = prior.reduce((sum, m) => sum + m.content.length, 0);
  while (prior.length > 0 && total > HISTORY_MAX_CHARS) {
    total -= prior.shift()!.content.length;
  }
  if (prior.length === 0) return { request: userContent, priorToolCalls };

  const history = prior.map((m) => `<message role="${m.role}">\n${m.content}\n</message>`).join("\n");
  return {
    request: `<conversation_history>\n${history}\n</conversation_history>\n\n${userContent}`,
    priorToolCalls,
  };
}

/**
 * Pairs up `assistant.tool_calls` with their matching `role: "tool"` results
 * (docs/adr/0035 §1) — the ONLY way a caller-executed tool's output reaches the
 * orchestrator, since there is no server-side conversation store.
 *
 * Scoped to messages AFTER the last user turn: those are the calls belonging to
 * the exchange currently in flight. Anything before it belongs to a completed
 * exchange and is already represented by the assistant prose in
 * `<conversation_history>` — replaying it as live tool history would make the
 * planner think it had just called those tools this turn.
 *
 * Note the two failure modes this closes. Before this existed, a `role: "tool"`
 * message was dropped outright (the history fold keeps only user/assistant), so
 * a client's result vanished and the planner would re-issue the same call
 * forever. And an assistant message carrying only `tool_calls` has
 * `content: null`, which the history fold skips — so lifting the pair out here
 * is also what keeps the call itself from disappearing.
 */
function collectPriorToolCalls(messages: ChatMessage[], userIdx: number): PriorCallerToolCall[] {
  // Every tool call the assistant asked for after the last user turn, in order.
  const requested = new Map<string, { name: string; arguments: string }>();
  for (let i = userIdx + 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }[]) {
      const id = call?.id;
      const name = call?.function?.name;
      if (typeof id !== "string" || typeof name !== "string") continue;
      const args = call.function?.arguments;
      requested.set(id, { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) });
    }
  }
  if (requested.size === 0) return [];

  const calls: PriorCallerToolCall[] = [];
  for (let i = userIdx + 1; i < messages.length; i++) {
    const message = messages[i];
    if (!message || message.role !== "tool") continue;
    const id = message.tool_call_id;
    if (typeof id !== "string") continue;
    const request = requested.get(id);
    // An unmatched result is skipped rather than guessed at: without the paired
    // call there's no tool name to attribute it to, so it would enter the
    // planner's history as an orphan blob.
    if (!request) continue;
    const content = typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null);
    calls.push({ id, name: request.name, arguments: request.arguments, result: content });
  }
  return calls;
}

/**
 * Open WebUI (and similar OpenAI-compatible chat UIs) send internal
 * housekeeping completions — generating a chat title, tags, a search query,
 * or a follow-up question — to the SAME /v1/chat/completions endpoint as
 * real user turns, using a well-known "### Task:" prompt prefix. These must
 * NEVER be routed through skill/agent delegation: a housekeeping call whose
 * embedded chat history happens to match e.g. the software-engineering agent
 * would silently launch a real, privileged AgentRun (cloning/creating repos,
 * opening pull requests) for what should be a cheap, side-effect-free text
 * completion. `server.ts` checks this before invoking the agent graph and
 * routes a match to `TaskCompleter` instead.
 */
export function isInternalUiTaskRequest(userContent: string): boolean {
  return userContent.trimStart().startsWith("### Task:");
}

/** Tool results are structured JSON, not prose; render them as readable chat content. */
export function renderResult(result: unknown): string {
  if (typeof result === "string") return result;
  return `\`\`\`json\n${JSON.stringify(result, null, 2)}\n\`\`\``;
}

export interface NodeStatusContext {
  /** True when checkActiveSkill confirmed the session skill for this turn. */
  skillContinuation?: boolean;
}

/**
 * Human-readable status line for a LangGraph "updates"-mode stream chunk,
 * keyed by node name. Reflects agent-graph node transitions (skill check ->
 * retrieve/select skill -> load skill tools -> plan action -> run tool ->
 * compose response), NOT the launched tool's own internal stages (e.g.
 * recipe-scraper's extract/transcribe) — those aren't currently plumbed out
 * of the Job callback protocol (known gap).
 */
const NODE_STATUS: Record<string, (update: Record<string, unknown>, ctx?: NodeStatusContext) => string | undefined> = {
  checkActiveSkill: (update) => {
    // Only narrate when the session's active skill was confirmed for this
    // turn (docs/adr/0012) — a fall-through to full retrieval is silent
    // (retrieveSkills/selectDelegate produce their own lines).
    const skill = update.selectedSkill as { name?: string } | undefined;
    return skill?.name ? `Continuing with skill: ${skill.name}.` : undefined;
  },
  checkActiveAgentRun: (update) => {
    // Same continuity narration for a running agent (question already
    // asked, this turn's message is its answer) — a fall-through is silent.
    const agent = update.selectedAgent as { name?: string } | undefined;
    return agent?.name ? `Continuing with agent: ${agent.name}.` : undefined;
  },
  retrieveSkills: (update) => {
    const candidates = Array.isArray(update.skillCandidates) ? update.skillCandidates : [];
    return `Found ${candidates.length} candidate skill(s).`;
  },
  retrieveAgents: (update) => {
    const candidates = Array.isArray(update.agentCandidates) ? update.agentCandidates : [];
    return `Found ${candidates.length} candidate agent(s).`;
  },
  selectDelegate: (update) => {
    const skill = update.selectedSkill as { name?: string } | undefined;
    if (skill?.name) return `Selected skill: ${skill.name}.`;
    const agent = update.selectedAgent as { name?: string } | undefined;
    if (agent?.name) return `Delegating to agent: ${agent.name}.`;
    return undefined;
  },
  loadSkillTools: (update, ctx) => {
    // Suppress on continuation turns: the skill (and its tools) didn't change,
    // so reporting the same tool count again is noise (docs/adr/0012).
    if (ctx?.skillContinuation) return undefined;
    const tools = Array.isArray(update.skillTools) ? update.skillTools : [];
    return `Loaded ${tools.length} tool(s) for this skill.`;
  },
  planAction: (update) => {
    const tool = update.selectedTool as { name?: string } | undefined;
    return tool?.name ? `Calling tool: ${tool.name}.` : undefined;
  },
};

export function nodeStatusText(
  nodeName: string,
  update: Record<string, unknown>,
  ctx?: NodeStatusContext,
): string | undefined {
  return NODE_STATUS[nodeName]?.(update, ctx);
}

export function chatCompletionId(): string {
  return `chatcmpl-${randomUUID()}`;
}

export function chatCompletionChunk(
  id: string,
  model: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
): unknown {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

/**
 * Renders pending caller-tool calls in OpenAI's `tool_calls` wire shape
 * (docs/adr/0035 §1). The client matches `function.name` back to one of its own
 * functions, runs it, and resends the conversation with a `role: "tool"` message
 * whose `tool_call_id` echoes `id`.
 */
function toolCallsPayload(calls: PendingToolCall[]): unknown[] {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: call.arguments },
  }));
}

/**
 * Blocking response for a turn that ended by asking the CALLER to run a tool.
 *
 * `content: null` (not `""`) and `finish_reason: "tool_calls"` are what tell an
 * OpenAI client this is a tool-call turn rather than a finished answer — a client
 * that sees `"stop"` here would render an empty assistant message and never
 * execute anything.
 */
export function chatCompletionToolCallResponse(id: string, model: string, calls: PendingToolCall[]): unknown {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: null, tool_calls: toolCallsPayload(calls) },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/**
 * Streaming counterpart: one delta carrying the whole `tool_calls` array (this
 * agent never streams partial arguments — the planner produces them in one shot,
 * so there is nothing to emit incrementally), followed by a
 * `finish_reason: "tool_calls"` chunk. `index` is required on each entry: it's
 * how a streaming client assembles multiple calls.
 */
export function toolCallDeltaChunk(id: string, model: string, calls: PendingToolCall[]): unknown {
  return chatCompletionChunk(
    id,
    model,
    {
      role: "assistant",
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    null,
  );
}

export function chatCompletionResponse(id: string, model: string, content: string, finishReason: string): unknown {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: finishReason }],
    // Token accounting isn't meaningful here (no LLM tokenizes the whole
    // pipeline) — zeroed rather than estimated, so clients don't mistake
    // this for real usage.
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

/** OpenAI's error envelope shape, so clients that special-case it (Open WebUI included) render it sensibly. */
export function openAiError(message: string, code: string): unknown {
  return { error: { message, type: "invalid_request_error", code } };
}

export function writeSseChunk(res: ServerResponse, payload: unknown): void {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Writes an Open WebUI status event. These render as a collapsible
 * StatusHistory indicator above the assistant message rather than as inline
 * text in the response — the proper way to surface agent progress steps.
 * `done: true` means the step completed; use `false` for an in-progress spinner.
 *
 * Format: Open WebUI's middleware (utils/middleware.py) checks for a top-level
 * `"event"` key in each SSE chunk and forwards it to the browser via socket.io,
 * which populates `message.statusHistory` and renders <StatusHistory>.
 */
export function writeSseStatus(res: ServerResponse, description: string, done = true): void {
  res.write(`data: ${JSON.stringify({ event: { type: "status", data: { description, done } } })}\n\n`);
}

export function writeSseComment(res: ServerResponse, comment: string): void {
  res.write(`: ${comment}\n\n`);
}

export function writeSseDone(res: ServerResponse): void {
  res.write("data: [DONE]\n\n");
}

/**
 * Maps an agent-graph failure (`AgentState.error`, a free-text string set by
 * the graph nodes in src/agent/graph.ts) to an HTTP status + OpenAI error
 * code for the non-streaming response. Streaming responses can't do this
 * (the 200 + SSE headers are already flushed by the time the graph settles),
 * so they instead render the error as the final assistant message.
 */
export function errorStatusAndCode(error: string): { status: number; code: string } {
  if (error.startsWith("unauthorized")) return { status: 401, code: "unauthorized" };
  if (error.startsWith("no matching skill")) return { status: 422, code: "no_skill_available" };
  if (error.startsWith("skill has no usable tools")) return { status: 422, code: "no_tool_available" };
  if (error.startsWith("planner selected a tool outside")) return { status: 500, code: "internal_error" };
  if (error.startsWith("tool failed")) return { status: 502, code: "tool_failed" };
  return { status: 500, code: "internal_error" };
}
