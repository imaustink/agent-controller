import { createHash } from "node:crypto";
import type { CallerToolChoice, CallerToolDescriptor } from "./types.js";

/**
 * Parses and validates the `tools` / `tool_choice` fields of an OpenAI
 * Chat Completions request (docs/adr/0035). Nothing here talks to the graph or
 * to Qdrant — it only turns untrusted request JSON into validated
 * {@link CallerToolDescriptor}s, or into an error the facade renders as a 400.
 *
 * Malformed input is REJECTED rather than silently dropped. Silently ignoring a
 * caller's tools is the behaviour this ADR exists to fix: a client that offers
 * tools and gets prose back has no way to tell whether the agent chose not to
 * call them or never saw them.
 */

/**
 * Hard cap on tool definitions per request. Well above what any real client
 * sends (Open WebUI with a populated tool server lands in the 30–80 range) —
 * this is an abuse ceiling, not a tuning knob, so exceeding it is an error
 * rather than a silent truncation that would make the agent look broken.
 */
export const MAX_CALLER_TOOLS = 128;
/** OpenAI's own function-name constraint. */
export const MAX_NAME_LENGTH = 64;
const NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
/** Per-tool description cap. Generous, but bounds what reaches the planner prompt. */
export const MAX_DESCRIPTION_LENGTH = 4_096;
/** Per-tool serialized JSON Schema cap. */
export const MAX_SCHEMA_LENGTH = 16_384;

export interface CallerToolParseError {
  error: string;
}

export interface CallerToolParseResult {
  tools: CallerToolDescriptor[];
  choice: CallerToolChoice;
}

/**
 * Recursively key-sorted JSON, so two structurally identical schemas that
 * differ only in property order hash to the same value. Without this, a client
 * that serializes its schema non-deterministically would miss the embedding
 * cache on every turn — the exact cost docs/adr/0035 §2 exists to avoid.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = canonicalize(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Content hash over the whole normalized definition — the store's point id.
 * Description and schema are part of it deliberately: an EDITED tool that keeps
 * its name is a different definition and must not resolve to the stale
 * embedding of the old one.
 */
function hashDefinition(name: string, description: string, parametersJson: string): string {
  return createHash("sha256").update(`${name}${description}${parametersJson}`).digest("hex");
}

/** Builds a descriptor (computing its hash) from already-validated parts. Exported for tests. */
export function makeCallerTool(name: string, description: string, parameters: unknown): CallerToolDescriptor {
  const parametersJson = JSON.stringify(canonicalize(parameters ?? { type: "object", properties: {} }));
  return { name, description, parametersJson, hash: hashDefinition(name, description, parametersJson) };
}

interface RawTool {
  type?: unknown;
  function?: { name?: unknown; description?: unknown; parameters?: unknown };
}

/**
 * Validates the request's `tools` array and `tool_choice`.
 *
 * Returns `{ tools: [], choice: { kind: "auto" } }` when the caller supplied no
 * tools at all — the overwhelmingly common case, and indistinguishable from
 * today's behaviour downstream.
 */
export function parseCallerTools(rawTools: unknown, rawToolChoice?: unknown): CallerToolParseResult | CallerToolParseError {
  const choice = parseToolChoice(rawToolChoice);
  if ("error" in choice) return choice;

  if (rawTools === undefined || rawTools === null) {
    return { tools: [], choice: choice.choice };
  }
  if (!Array.isArray(rawTools)) {
    return { error: "tools must be an array" };
  }
  if (rawTools.length > MAX_CALLER_TOOLS) {
    return { error: `tools may contain at most ${MAX_CALLER_TOOLS} entries (received ${rawTools.length})` };
  }

  const tools: CallerToolDescriptor[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of (rawTools as RawTool[]).entries()) {
    if (!entry || typeof entry !== "object") {
      return { error: `tools[${index}] must be an object` };
    }
    // Only `type: "function"` exists in the tools array today. An unknown type
    // is rejected rather than skipped: skipping would leave the caller
    // believing a tool is on offer when it isn't.
    if (entry.type !== undefined && entry.type !== "function") {
      return { error: `tools[${index}].type must be "function"` };
    }
    const fn = entry.function;
    if (!fn || typeof fn !== "object") {
      return { error: `tools[${index}].function must be an object` };
    }
    const name = fn.name;
    if (typeof name !== "string" || name === "") {
      return { error: `tools[${index}].function.name must be a non-empty string` };
    }
    if (name.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
      return {
        error: `tools[${index}].function.name must match [a-zA-Z0-9_-]{1,${MAX_NAME_LENGTH}} (received "${name}")`,
      };
    }
    // Duplicate names would make the tool_call round trip ambiguous — the
    // client matches our `tool_calls[].function.name` back to one of its own
    // functions, and there'd be no answer to which one.
    if (seen.has(name)) {
      return { error: `tools contains duplicate function name "${name}"` };
    }
    seen.add(name);

    const description = fn.description === undefined || fn.description === null ? "" : fn.description;
    if (typeof description !== "string") {
      return { error: `tools[${index}].function.description must be a string` };
    }
    if (description.length > MAX_DESCRIPTION_LENGTH) {
      return { error: `tools[${index}].function.description exceeds ${MAX_DESCRIPTION_LENGTH} characters` };
    }
    if (fn.parameters !== undefined && fn.parameters !== null && typeof fn.parameters !== "object") {
      return { error: `tools[${index}].function.parameters must be a JSON Schema object` };
    }

    let tool: CallerToolDescriptor;
    try {
      tool = makeCallerTool(name, description, fn.parameters);
    } catch {
      // Only reachable for a schema that can't be serialized at all (circular
      // structure) — JSON.parse can't produce one, but the /invoke path accepts
      // an already-parsed object too.
      return { error: `tools[${index}].function.parameters must be JSON-serializable` };
    }
    if (tool.parametersJson.length > MAX_SCHEMA_LENGTH) {
      return { error: `tools[${index}].function.parameters exceeds ${MAX_SCHEMA_LENGTH} serialized characters` };
    }
    tools.push(tool);
  }

  // A named `tool_choice` must actually be on offer; otherwise the caller has
  // asked for something that cannot happen and would get a silently ordinary
  // answer instead.
  if (choice.choice.kind === "function" && !seen.has(choice.choice.name)) {
    return { error: `tool_choice names "${choice.choice.name}", which is not present in tools` };
  }
  return { tools, choice: choice.choice };
}

function parseToolChoice(raw: unknown): { choice: CallerToolChoice } | CallerToolParseError {
  if (raw === undefined || raw === null) return { choice: { kind: "auto" } };
  if (typeof raw === "string") {
    if (raw === "auto") return { choice: { kind: "auto" } };
    if (raw === "none") return { choice: { kind: "none" } };
    // "required" is honored as a strong planner directive, not a hard
    // constraint — see docs/adr/0035 §5 for why we don't claim to enforce it.
    if (raw === "required") return { choice: { kind: "auto", required: true } };
    return { error: `tool_choice must be "auto", "none", "required", or a {type:"function"} object` };
  }
  if (typeof raw === "object") {
    const obj = raw as { type?: unknown; function?: { name?: unknown } };
    if (obj.type !== "function" || !obj.function || typeof obj.function !== "object") {
      return { error: 'tool_choice object must be of the form {type:"function",function:{name}}' };
    }
    const name = obj.function.name;
    if (typeof name !== "string" || name === "") {
      return { error: "tool_choice.function.name must be a non-empty string" };
    }
    return { choice: { kind: "function", name } };
  }
  return { error: "tool_choice must be a string or an object" };
}
