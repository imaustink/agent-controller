import type { ToolDescriptor } from "../tool-descriptor.js";
import { callerToolId, type CallerToolChoice, type CallerToolDescriptor, type CallerToolStore } from "./types.js";

/**
 * Decides WHICH of a caller's supplied tools reach the action planner
 * (docs/adr/0035 §3) — the just-in-time vectorization step.
 *
 * The ordering here is the whole point. Retrieval is only worth its cost when
 * there is actually something to prune, so a caller sending a handful of tools
 * pays nothing at all: no embedding, no Qdrant round trip, no added latency on
 * the hot path. Only a caller with a large tool array (the case that would
 * otherwise drown a Skill's own 1–5 declared tools in the planner's prompt) gets
 * indexed and ranked.
 */
export async function resolveCallerTools(
  request: string,
  tools: CallerToolDescriptor[],
  choice: CallerToolChoice,
  topK: number,
  store?: CallerToolStore,
  onWarn?: (message: string, err: unknown) => void,
): Promise<CallerToolDescriptor[]> {
  // Caller explicitly opted out for this turn.
  if (choice.kind === "none" || tools.length === 0) return [];

  // A named tool_choice is already a selection — ranking one candidate against
  // itself would be pure overhead, and offering the others would contradict the
  // caller's explicit instruction.
  if (choice.kind === "function") {
    const named = tools.find((tool) => tool.name === choice.name);
    return named ? [named] : [];
  }

  // Nothing to prune: every tool fits in the planner's budget already.
  if (tools.length <= topK) return tools;

  if (!store) {
    // No caller-tool store configured (e.g. a deployment without Qdrant wired
    // for it). Degrade to a truncation rather than dropping the feature: the
    // caller still gets tool calling, just without relevance ranking.
    onWarn?.("caller-tool store not configured; truncating to the first tools without ranking", undefined);
    return tools.slice(0, topK);
  }

  try {
    await store.index(tools);
    const ranked = await store.search(request, tools, topK);
    // An empty result from a healthy store would mean the request matched
    // nothing — but it also happens if the collection lost the points between
    // index and search. Truncation is the safer read of an empty set here, since
    // "caller offered 40 tools and none were even considered" is the worse
    // failure.
    return ranked.length > 0 ? ranked : tools.slice(0, topK);
  } catch (err) {
    onWarn?.("caller-tool retrieval failed; truncating to the first tools without ranking", err);
    return tools.slice(0, topK);
  }
}

/**
 * Adapts a caller tool into the same {@link ToolDescriptor} shape the rest of
 * the graph already dispatches on, with `callerTool` joining
 * `jobTemplate`/`localExec`/`agentRunTemplate` as a fourth mutually-exclusive
 * kind — the only one `runTool` doesn't execute.
 *
 * `allowedRoles` is empty because caller tools are never indexed into, or
 * retrieved from, the RBAC-filtered `VectorStore`: authorization is vacuous for
 * a function the caller both supplied and will run themselves (docs/adr/0035
 * §2). Empty is also the fail-closed value everywhere else in this codebase, so
 * if some future path ever did filter these by role, the accident would be
 * "invisible" rather than "visible to everyone".
 */
export function toCallerToolDescriptor(tool: CallerToolDescriptor): ToolDescriptor {
  return {
    id: callerToolId(tool.name),
    name: tool.name,
    description: tool.description,
    allowedRoles: [],
    callerTool: tool,
  };
}
