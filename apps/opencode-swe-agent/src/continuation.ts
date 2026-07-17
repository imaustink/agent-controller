/**
 * Wire-level continuation marker (docs/adr/0017), matching the generic
 * `<!-- continuation: <token> -->` convention the orchestrator uses for
 * per-tool continuation tokens (apps/agent-orchestrator/src/continuation.ts).
 * For this agent, the orchestrator's `delegateToAgent` node prepends the
 * marker to the goal it hands a NEW AgentRun when the caller's session has a
 * saved token for this agent id — never to the chat transcript itself, so it
 * never reaches the LLM planner (docs/security.md).
 *
 * Duplicated here rather than imported: this app ships as a standalone
 * container image built from its own package, with no access to the
 * orchestrator's source tree.
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
