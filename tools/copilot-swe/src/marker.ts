/**
 * Round-trips the identity of the repository/branch/pull-request a coding
 * conversation is about, through the chat transcript itself. This
 * orchestrator is stateless per request (docs/adr/0008) — there is no
 * server-side memory of "which PR is this chat about". A leading HTML comment
 * is invisible in a rendered chat message but present in the raw text, so it
 * survives the orchestrator's `<conversation_history>` fold
 * (apps/agent-orchestrator/src/openai/chat-completions.ts) into the next turn
 * without the user ever seeing or having to repeat it. Same technique as
 * recipe-publisher's `<!-- mealie-slug: ... -->` marker.
 *
 * SECURITY NOTE: values extracted here are only as trustworthy as the chat
 * history they came from, which can include untrusted content. A sufficiently
 * effective prompt injection could cause the assistant to echo back a
 * different repo/branch. Blast radius is bounded to the repositories the
 * GitHub App is installed on (the installation token cannot reach others) —
 * documented as a known risk in docs/security.md, not silently accepted.
 */

export interface SweMarker {
  /** "owner/name" of the repository being worked on. */
  repo: string;
  /** Working branch. */
  branch: string;
  /** Pull request number, if one has been opened yet. */
  pr: string | null;
  /** Stable session id (also used as the Copilot CLI --session-id). */
  session: string;
}

// Only matches at the very start of the string. Fields are whitespace-
// separated `key=value` pairs with tightly constrained value character sets
// (no spaces, no shell metacharacters) so a marker can never smuggle an
// argument into a later git/gh command.
const SWE_MARKER = /^<!--\s*swe:\s*([^>]*?)\s*-->\n*/i;
const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const PR_RE = /^\d+$/;
const SESSION_RE = /^[A-Za-z0-9-]+$/;

function parseFields(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of body.split(/\s+/).filter(Boolean)) {
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    out[pair.slice(0, eq).toLowerCase()] = pair.slice(eq + 1);
  }
  return out;
}

/**
 * Strips a leading `<!-- swe: ... -->` marker if present and well-formed,
 * returning it separately from the rest of the instruction text. A malformed
 * marker (bad repo/branch/etc.) is treated as absent and left in the text
 * rather than trusted — fail closed.
 */
export function parseSweMarker(input: string): { marker: SweMarker | null; instruction: string } {
  const match = input.match(SWE_MARKER);
  if (!match) return { marker: null, instruction: input };

  const fields = parseFields(match[1] ?? "");
  const repo = fields.repo ?? "";
  const branch = fields.branch ?? "";
  const pr = fields.pr ?? "";
  const session = fields.session ?? "";

  if (!REPO_RE.test(repo) || !REF_RE.test(branch) || !SESSION_RE.test(session)) {
    return { marker: null, instruction: input };
  }
  if (pr !== "" && !PR_RE.test(pr)) {
    return { marker: null, instruction: input };
  }

  return {
    marker: { repo, branch, pr: pr === "" ? null : pr, session },
    instruction: input.slice(match[0].length),
  };
}

/** Renders the marker to prepend to the agent's response so the next turn can read it back. */
export function renderSweMarker(marker: SweMarker): string {
  const parts = [`repo=${marker.repo}`, `branch=${marker.branch}`];
  if (marker.pr) parts.push(`pr=${marker.pr}`);
  parts.push(`session=${marker.session}`);
  return `<!-- swe: ${parts.join(" ")} -->\n\n`;
}
