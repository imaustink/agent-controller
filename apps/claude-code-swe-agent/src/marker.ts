/**
 * Encodes/decodes this agent's cross-episode continuation state — which
 * repository/branch/PR a coding task is about — into the opaque token
 * carried by the generic continuation mechanism (docs/adr/0017):
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
 * Unlike opencode-swe-agent (ADR 0026), this agent runs one `claude -p`
 * invocation per AgentRun and exits — there is no long-lived local server
 * for a later episode's fresh Job/Pod to resume against, so `session` here
 * is only a locally generated identifier for logging/traceability, not a
 * real Claude Code session id ever passed to `--resume`. Continuation across
 * turns instead comes entirely from re-cloning `repo`/`branch` and re-framing
 * the task with the saved PR context (see ./claude.ts's `buildPrompt`).
 */

export interface SweMarker {
  /** "owner/name" of the repository being worked on. */
  repo: string;
  /** Working branch. */
  branch: string;
  /** Pull request number, if one has been opened yet. */
  pr: string | null;
  /** Locally generated identifier carried across continuation turns (see class doc — not a resumable Claude Code session id). */
  session: string;
}

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const REF_RE = /^[A-Za-z0-9._/-]+$/;
const PR_RE = /^\d+$/;
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
