/**
 * Generic per-tool continuation token (docs/adr/0016): the orchestrator
 * strips this marker from tool success outputs, stores the opaque token
 * (keyed by toolId) in the session store, and re-injects it into tool_args
 * on the next turn for the SAME tool. Tool-specific state (repo, branch, pr,
 * Mealie slug, etc.) is encoded inside the opaque token by each tool — the
 * orchestrator never parses the token content.
 *
 * This replaces the prior conversation-text round-trip (e.g.
 * `<!-- swe: ... -->`, `<!-- mealie-slug: ... -->`) which carried state
 * through the chat transcript and was a documented prompt-injection risk
 * (docs/security.md). Storing state server-side removes that attack surface:
 * the token never appears in the transcript the LLM planner sees.
 */

const CONTINUATION_MARKER_RE = /^<!--\s*continuation:\s*([\s\S]*?)\s*-->\r?\n*/i;

/**
 * Strips a leading `<!-- continuation: <token> -->` marker from a string.
 * Returns the extracted token and the remainder (with the marker removed).
 * If no marker is present, `token` is `null` and `text` is the original string.
 */
export function extractContinuationToken(text: string): { token: string | null; text: string } {
  const match = text.match(CONTINUATION_MARKER_RE);
  if (!match) return { token: null, text };
  const token = match[1]?.trim() || null;
  return { token, text: text.slice(match[0].length) };
}

/**
 * Prepends a `<!-- continuation: <token> -->\n\n` marker to a string,
 * producing the `tool_args` the orchestrator will pass to a tool on the next
 * turn when an existing continuation token is found in the session.
 */
export function prependContinuationToken(token: string, text: string): string {
  return `<!-- continuation: ${token} -->\n\n${text}`;
}

/**
 * Resolves the session key a tool's continuation token is stored under
 * (docs/adr/0017), WITHOUT depending on the model to re-supply an instance id
 * each turn.
 *
 * The instance scope (`${toolId}::${instanceKey}`) exists so two instances of a
 * multi-instance tool in one conversation — say two recipes being published —
 * don't clobber each other's saved state. The id that distinguished them used to
 * be a URL the planner copied verbatim into `tool_instance_key` on EVERY call;
 * a core continuity behaviour then depended on the model re-extracting it, and a
 * refine turn where it didn't lost the publish target (orphaning the Mealie
 * entry). This derives the key from SERVER-SIDE state instead:
 *
 * - An explicit `instanceKey` (the planner naming a specific instance, e.g.
 *   switching to a different recipe) always wins — that is the one case where
 *   the model genuinely selects among instances.
 * - Otherwise, when the session already holds exactly ONE continuation entry for
 *   this tool, reuse THAT key: the conversation's active instance is recovered
 *   from state, so a refine turn continues the same target with no model input.
 * - Otherwise fall back to the bare tool id (first call, or ambiguous).
 *
 * `existing` is the live `toolContinuations` map (keys like `toolId` or
 * `toolId::<instance>`). PARITY: `continuation.ResolveKey` on the Temporal
 * engine.
 */
export function resolveContinuationKey(
  toolId: string,
  instanceKey: string | undefined,
  existing: Readonly<Record<string, string>> | undefined,
): string {
  if (instanceKey) return `${toolId}::${instanceKey}`;
  const prefix = `${toolId}::`;
  const own = existing
    ? Object.keys(existing).filter((k) => k === toolId || k.startsWith(prefix))
    : [];
  // Exactly one active instance: recover it from server state. More than one
  // (genuinely multi-instance) is ambiguous without the planner naming which, so
  // fall back rather than guess and risk writing one recipe's edit onto another.
  if (own.length === 1) return own[0]!;
  return toolId;
}
