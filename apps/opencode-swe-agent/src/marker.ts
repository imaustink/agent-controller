/**
 * Encodes/decodes this agent's cross-episode continuation state — which
 * repository/branch/PR/session a coding task is about — into the opaque
 * token carried by the generic continuation mechanism (docs/adr/0017):
 *
 *  - Outgoing: the agent returns `{ message, result: encodeSweContinuation(marker) }`
 *    from its `runAgent` handler. `result` is a structured field on the
 *    NATS `reply` message (packages/messaging/src/agent-protocol.ts),
 *    separate from `message` — it never appears in the chat transcript the
 *    user or the orchestrator's LLM planner sees. The orchestrator stores it
 *    server-side, keyed by this agent's id (SessionRecord.agentContinuations).
 *  - Incoming: on the NEXT episode for the same conversation, the
 *    orchestrator's `delegateToAgent` node prepends
 *    `<!-- continuation: <token> -->` to the new AgentRun's goal (see
 *    ./continuation.ts for stripping that wrapper); `decodeSweContinuation`
 *    turns the resulting token back into a `SweMarker`.
 *
 * This replaces the prior design, where the agent embedded a
 * `<!-- swe: ... -->` marker directly in its chat reply and relied on the
 * orchestrator's conversation-history fold to carry it into the next turn's
 * `session.goal` — a documented prompt-injection surface (docs/security.md):
 * a sufficiently effective injection earlier in the transcript could forge a
 * different repo/branch. Routing the same data through the orchestrator's
 * session store instead of the transcript closes that off — the value never
 * passes through anything an LLM reads or writes.
 */

export interface SweMarker {
  /** "owner/name" of the repository being worked on. */
  repo: string;
  /** Working branch. */
  branch: string;
  /** Pull request number, if one has been opened yet. */
  pr: string | null;
  /** Stable session id carried across continuation turns. */
  session: string;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const PR_RE = /^\d+$/;
// Allows an underscore: since ADR 0026, `session` is the REAL opencode
// session id (e.g. "ses_abc123"), not a locally-generated UUID.
const SESSION_RE = /^[A-Za-z0-9_-]+$/;

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
 * Decodes a continuation token (whitespace-separated `key=value` pairs, no
 * shell metacharacters allowed in values) back into a `SweMarker`. A
 * malformed or absent token decodes to `null` — treated as "no continuation"
 * rather than trusted partial data, fail closed.
 */
export function decodeSweContinuation(token: string | null): SweMarker | null {
  if (!token) return null;

  const fields = parseFields(token);
  const repo = fields.repo ?? "";
  const branch = fields.branch ?? "";
  const pr = fields.pr ?? "";
  const session = fields.session ?? "";

  if (!REPO_RE.test(repo) || !REF_RE.test(branch) || !SESSION_RE.test(session)) {
    return null;
  }
  if (pr !== "" && !PR_RE.test(pr)) {
    return null;
  }

  return { repo, branch, pr: pr === "" ? null : pr, session };
}

/** Encodes a `SweMarker` as the opaque continuation token for the NEXT episode. */
export function encodeSweContinuation(marker: SweMarker): string {
  const parts = [`repo=${marker.repo}`, `branch=${marker.branch}`];
  if (marker.pr) parts.push(`pr=${marker.pr}`);
  parts.push(`session=${marker.session}`);
  return parts.join(" ");
}
