/**
 * Declarative tool-approval policy (ADR 0003).
 *
 * A tool call is gated by an effective policy resolved most-specific-wins:
 * the tool's own `approval`, else the governing agent's `approvalDefault`
 * (only in the sub-agent loop — the top-level graph has no agent default),
 * else `"never"`. An empty string ALWAYS resolves to `"never"` so existing
 * CRs that set no policy keep running silently.
 *
 * Semantics: `never` runs silently (today's behavior); `always` requires human
 * approval before executing; `auto` is treated as `always` for now (an
 * evaluator is a deferred phase).
 *
 * This module is pure (no graph/session state) so both the top-level graph
 * (`graph.ts`) and the sub-agent dispatcher (`dispatch-tool.ts`) share one
 * source of truth, and so the resolution/parsing can be unit-tested directly.
 * PARITY: the Go engine resolves and parses identically.
 */

export type ApprovalPolicy = "never" | "always" | "auto";

export type ApprovalDecision = "approve" | "deny" | "ambiguous";

/** The one human-facing prompt both engines emit — used VERBATIM (ADR 0003). */
export function approvalPrompt(toolId: string): string {
  return `Approval required: run tool "${toolId}"? Reply "approve" or "deny".`;
}

/** Failure taxonomy for a call the user denied. */
export const APPROVAL_DENIED_CODE = "approval_denied";
export const APPROVAL_DENIED_MESSAGE = "Tool call was denied by the user.";

/**
 * Resolve the effective approval policy, most-specific-wins. An unknown or
 * empty value at any level is ignored (treated as unset), so a malformed CR
 * never silently escalates a call's gating — it falls through to the next
 * level and ultimately to `"never"`.
 */
export function resolveApproval(
  toolApproval: string | undefined,
  agentDefault: string | undefined,
): ApprovalPolicy {
  return normalizePolicy(toolApproval) ?? normalizePolicy(agentDefault) ?? "never";
}

/**
 * Whether an effective policy requires human approval before executing.
 * `auto` is treated as `always` until the deferred evaluator phase.
 */
export function requiresApproval(policy: ApprovalPolicy): boolean {
  // TODO(ADR 0003 A3): consult evaluator — for now `auto` behaves as `always`.
  return policy === "always" || policy === "auto";
}

function normalizePolicy(value: string | undefined): ApprovalPolicy | undefined {
  switch ((value ?? "").trim().toLowerCase()) {
    case "never":
      return "never";
    case "always":
      return "always";
    case "auto":
      return "auto";
    default:
      // Empty string (existing CRs) and any unrecognized value are "unset".
      return undefined;
  }
}

const APPROVE_WORDS = new Set([
  "approve",
  "approved",
  "yes",
  "y",
  "ok",
  "okay",
  "allow",
  "allowed",
  "confirm",
  "confirmed",
]);

const DENY_WORDS = new Set([
  "deny",
  "denied",
  "no",
  "n",
  "reject",
  "rejected",
  "cancel",
  "cancelled",
  "stop",
  "disallow",
]);

/**
 * Interpret the user's reply to an approval prompt deterministically, with a
 * deliberate safety asymmetry (PARITY: engines/temporal/internal/approval
 * ParseDecision): STRICT about approving, LIBERAL about denying, so the gate
 * fails toward NOT running a tool.
 *
 * - Deny is checked FIRST and matches if ANY word in the reply is a deny word,
 *   so "deny, i would never approve this!" denies (the embedded "approve" is
 *   ignored) and "approve, no" denies too.
 * - Approve matches ONLY when the whole reply is a single approve word, so a
 *   sentence that merely contains "approve" never runs the tool — it re-asks.
 *
 * Anything else is AMBIGUOUS; the caller re-asks rather than guessing.
 */
export function parseApprovalDecision(message: string | undefined): ApprovalDecision {
  // Strip a single trailing punctuation mark so "approve." / "yes!" still count.
  const normalized = (message ?? "").trim().toLowerCase().replace(/[.!,]$/, "");
  // Deny first, token-wise: any deny word anywhere in the reply denies.
  const tokens = normalized.split(/[^a-z]+/).filter(Boolean);
  if (tokens.some((t) => DENY_WORDS.has(t))) return "deny";
  // Approve strictly: only a bare approve word (the whole reply) approves.
  if (APPROVE_WORDS.has(normalized)) return "approve";
  return "ambiguous";
}
