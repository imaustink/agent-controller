import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";

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
}

export function listModelsResponse(): unknown {
  return {
    object: "list",
    data: [{ id: MODEL_ID, object: "model", created: Math.floor(Date.now() / 1000), owned_by: "recipe-agent" }],
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

/** Most recent prior messages folded into the request (see {@link buildAgentRequest}). */
const HISTORY_MAX_MESSAGES = 8;
/** Total character budget for folded history; oldest messages dropped first when exceeded. */
const HISTORY_MAX_CHARS = 24_000;

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
 */
export function buildAgentRequest(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  const arr = messages as ChatMessage[];
  const userIdx = findLastMessageIndex(arr, "user");
  if (userIdx === -1) return undefined;
  const userContent = arr[userIdx]!.content as string;

  // Collect prior user/assistant turns, newest-last, bounded by count.
  const prior: { role: string; content: string }[] = [];
  for (let i = userIdx - 1; i >= 0 && prior.length < HISTORY_MAX_MESSAGES; i--) {
    const message = arr[i];
    if (!message || typeof message !== "object") continue;
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (typeof message.content !== "string" || message.content.trim() === "") continue;
    prior.unshift({ role: message.role, content: message.content });
  }
  // Enforce the char budget by dropping oldest first.
  let total = prior.reduce((sum, m) => sum + m.content.length, 0);
  while (prior.length > 0 && total > HISTORY_MAX_CHARS) {
    total -= prior.shift()!.content.length;
  }
  if (prior.length === 0) return userContent;

  const history = prior.map((m) => `<message role="${m.role}">\n${m.content}\n</message>`).join("\n");
  return `<conversation_history>\n${history}\n</conversation_history>\n\n${userContent}`;
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
 * retrieve/select skill -> load skill tools -> plan action -> launch), NOT
 * the launched tool's own internal stages (e.g. recipe-scraper's
 * extract/transcribe) — those aren't currently plumbed out of the Job
 * callback protocol (known gap).
 */
const NODE_STATUS: Record<string, (update: Record<string, unknown>, ctx?: NodeStatusContext) => string | undefined> = {
  checkActiveSkill: (update) => {
    // Only narrate when the session's active skill was confirmed for this
    // turn (docs/adr/0012) — a fall-through to full retrieval is silent
    // (retrieveSkills/selectSkill produce their own lines).
    const skill = update.selectedSkill as { name?: string } | undefined;
    return skill?.name ? `Continuing with skill: ${skill.name}.` : undefined;
  },
  retrieveSkills: (update) => {
    const candidates = Array.isArray(update.skillCandidates) ? update.skillCandidates : [];
    return `Found ${candidates.length} candidate skill(s).`;
  },
  selectSkill: (update) => {
    const skill = update.selectedSkill as { name?: string } | undefined;
    return skill?.name ? `Selected skill: ${skill.name}.` : undefined;
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
