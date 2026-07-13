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
