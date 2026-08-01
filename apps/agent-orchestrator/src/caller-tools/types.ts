/**
 * Caller-supplied tools (docs/adr/0035) — the third level of tool calling,
 * alongside the orchestrator's own Skill-scoped loop (ADR 0008) and a
 * sub-agent's internal loop (ADR 0028).
 *
 * Unlike both of those, these tools come from the REQUEST BODY
 * (`/v1/chat/completions`'s `tools` array) and are executed by the CALLER's own
 * client, never by the orchestrator or the core-controller. The orchestrator's
 * only job is to decide that one of them fits, hand back an OpenAI-shaped
 * `tool_calls`, and pick the conversation back up when the client resends with
 * the result.
 */

/** Id prefix that namespaces every caller tool away from the `Tool` CR catalog. */
export const CALLER_TOOL_ID_PREFIX = "caller:";

/** Builds the namespaced descriptor id for a caller tool's function name. */
export function callerToolId(name: string): string {
  return `${CALLER_TOOL_ID_PREFIX}${name}`;
}

/** True when a descriptor id belongs to the caller-tool namespace. */
export function isCallerToolId(id: string): boolean {
  return id.startsWith(CALLER_TOOL_ID_PREFIX);
}

/**
 * One normalized, validated caller-supplied function definition.
 *
 * Every text field here is **untrusted** — it arrives per-request from whoever
 * holds a bearer token, one trust level below a `Tool` CR description
 * (semi-trusted, authored by that tool's owner) and two below Skill markdown
 * (trusted). It still has to reach the planner's prompt to be selectable at
 * all, so it's rendered inside a distinctly-labeled untrusted block and the
 * planner's chosen id is re-validated against the resolved list, exactly as for
 * catalog tools.
 */
export interface CallerToolDescriptor {
  /**
   * The function name as the CLIENT knows it — this exact string goes back out
   * in `tool_calls[].function.name`, so it must never be rewritten.
   */
  name: string;
  /** Natural-language description; the text that gets embedded. */
  description: string;
  /**
   * The function's JSON Schema (OpenAI's `function.parameters`), carried
   * through verbatim so the planner can produce conforming arguments. Kept as
   * an already-serialized string: the orchestrator never interprets it, and
   * stringifying once here keeps both the content hash and the Qdrant payload
   * stable regardless of key ordering elsewhere.
   */
  parametersJson: string;
  /**
   * sha256 over the normalized definition (name + description + canonicalized
   * schema). Doubles as the store's point id, which is what makes the
   * collection an embedding cache rather than per-turn write amplification
   * (docs/adr/0035 §2).
   */
  hash: string;
}

/**
 * How the caller constrained tool selection (OpenAI's `tool_choice`).
 *
 * `"required"` is deliberately absent as a distinct kind: the planner is our
 * own Structured-Outputs call and can't be made to guarantee a tool call, so
 * it's carried as `auto` plus a prompt directive rather than as a promise the
 * dispatch layer would be lying about (docs/adr/0035 §5).
 */
export type CallerToolChoice =
  | { kind: "auto"; required?: boolean }
  /** Caller explicitly opted out for this turn — caller tools are dropped entirely. */
  | { kind: "none" }
  /** Caller named one function; retrieval is bypassed and only that one is offered. */
  | { kind: "function"; name: string };

/**
 * A tool call the orchestrator is asking the CALLER to execute. Rendered as
 * `choices[0].message.tool_calls` with `finish_reason: "tool_calls"`; the
 * client runs it and resends the conversation with a matching `role: "tool"`
 * message.
 */
export interface PendingToolCall {
  /**
   * Correlation id the client echoes back as `tool_call_id`. Generated here
   * (the client has no say) and matched purely by string equality on the way
   * back in.
   */
  id: string;
  name: string;
  /** JSON-encoded arguments, per OpenAI's wire format (a string, not an object). */
  arguments: string;
}

/**
 * A completed caller-executed tool call, parsed back off the wire from an
 * `assistant.tool_calls` message plus its matching `role: "tool"` result
 * (docs/adr/0035 §1). This is the ONLY way a caller tool's result reaches the
 * orchestrator — there is no server-side conversation store to read it from.
 */
export interface PriorCallerToolCall {
  id: string;
  name: string;
  arguments: string;
  /** The `role: "tool"` message's content, verbatim. */
  result: string;
}

/**
 * Port for the caller-tool index (docs/adr/0035 §2). Its own collection,
 * deliberately separate from the `tools` catalog so caller definitions can
 * never enter another caller's candidate set, `selectFallbackTool`'s
 * catalog-wide query, or a sub-agent's `toolRefs` resolution.
 *
 * There is no RBAC filter here, unlike every other store in this codebase.
 * That is not an oversight: `search` only ever ranks definitions whose hashes
 * came from the request body being served, so it cannot surface anything the
 * caller didn't just supply — and "may this caller use this tool?" is vacuous
 * for a function the caller both supplied and will run themselves, in their own
 * process, under their own credentials.
 */
export interface CallerToolStore {
  /**
   * Embeds and upserts only those `tools` not already indexed, and refreshes
   * `lastSeenAt` on the ones that were. Idempotent; safe to call per turn.
   */
  index(tools: CallerToolDescriptor[]): Promise<void>;
  /**
   * Ranks `tools` by similarity to `text` and returns the best `k`, restricted
   * to the given set — never a search across the whole collection.
   * Implementations MUST NOT return a definition whose hash isn't in `tools`.
   */
  search(text: string, tools: CallerToolDescriptor[], k: number): Promise<CallerToolDescriptor[]>;
  /**
   * Drops definitions not seen for `olderThanMs`. Qdrant has no native TTL, so
   * this is swept periodically from index.ts rather than expiring on its own.
   */
  prune(olderThanMs: number): Promise<number>;
}
