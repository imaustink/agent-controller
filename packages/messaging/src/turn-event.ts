import { z } from "zod";
import { ArtifactRefSchema, type ArtifactRef } from "./artifact.js";

/**
 * A unified lifecycle event stream (ADR 0004).
 *
 * Where {@link Event} is the TOOL-level wire contract (one tool call's
 * accepted -> progress -> succeeded/failed), a `TurnEvent` is the TURN-level
 * envelope: the ordered lifecycle points an orchestrator already narrates to a
 * client over a turn — a skill was selected, a tool started/progressed/
 * finished/failed, a warning, the two approval-gate transitions (ADR 0003), and
 * the turn boundaries.
 *
 * B1 scope ("typed envelope, same transport"): the orchestrator constructs
 * these for the points it already narrates and down-converts them with
 * {@link renderTurnEvent} at the SSE edge, so the status strings clients receive
 * are byte-for-byte unchanged — the envelope is simply the single typed source
 * the strings are projected FROM. Durability/replay is a later phase.
 */

/** The lifecycle points a turn can emit. A plain string union, like `Event.type`. */
export const TURN_EVENT_KINDS = [
  "turn-started",
  "skill-selected",
  "tool-started",
  "tool-progress",
  "tool-finished",
  "tool-failed",
  "warning",
  "approval-required",
  "approval-resolved",
  "turn-completed",
] as const;

export type TurnEventKind = (typeof TURN_EVENT_KINDS)[number];

/**
 * Runtime shape validation. Mirrors {@link EventSchema}'s style: a small fixed
 * envelope with intentionally loose, optional detail fields (`stage`/`code` are
 * free-form strings a producer defines for its own pipeline/taxonomy, exactly
 * as on `Event`).
 */
export const TurnEventSchema = z.object({
  /** Monotonic per-turn sequence number; gives ordering and dedupe (as on `Event.seq`). */
  seq: z.number().int().nonnegative(),
  /** ISO 8601 emission timestamp (as on `Event.ts`). */
  ts: z.string(),
  kind: z.enum(TURN_EVENT_KINDS),
  skillId: z.string().optional(),
  toolId: z.string().optional(),
  stage: z.string().optional(),
  pct: z.number().min(0).max(100).optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  artifacts: z.array(ArtifactRefSchema).optional(),
});

export interface TurnEvent {
  seq: number;
  ts: string;
  kind: TurnEventKind;
  skillId?: string;
  toolId?: string;
  stage?: string;
  pct?: number;
  code?: string;
  message?: string;
  artifacts?: ArtifactRef[];
}

/**
 * The shared approval prompt wording (ADR 0003) — used VERBATIM by both engines
 * and kept here so the typed envelope renders the exact same line a client sees
 * as the turn's approval request.
 */
export function approvalRequiredLine(toolId: string): string {
  return `Approval required: run tool "${toolId}"? Reply "approve" or "deny".`;
}

/**
 * Down-converts a {@link TurnEvent} to the single human-facing status line a
 * client renders today. It reuses the engine's EXISTING conventions rather than
 * inventing wording:
 *
 *  - the tool-lifecycle kinds (`tool-*`, `warning`) reproduce the orchestrator's
 *    `progressListener` status label exactly — `"<stage>: <message>"` (message
 *    clamped to 120 chars), or the bare `stage`, or `"working…"`;
 *  - `skill-selected` reuses `NODE_STATUS.selectDelegate`'s `"Selected skill: X."`;
 *  - `approval-required` reuses the shared ADR 0003 prompt;
 *  - the remaining boundary kinds render a short, stable line.
 */
export function renderTurnEvent(e: TurnEvent): string {
  switch (e.kind) {
    case "turn-started":
      return "Starting…";
    case "skill-selected":
      return `Selected skill: ${e.message ?? e.skillId ?? "unknown"}.`;
    case "approval-required":
      return approvalRequiredLine(e.toolId ?? "");
    case "approval-resolved":
      return `Approval ${e.code ?? "resolved"}: tool "${e.toolId ?? ""}".`;
    case "turn-completed":
      return "Done.";
    case "tool-started":
    case "tool-progress":
    case "tool-finished":
    case "tool-failed":
    case "warning":
    default:
      // The exact label `progressListener` produces for a mechanical status step
      // (chat-completions.ts): "<stage>: <message>" with message clamped, else
      // the bare stage, else a working placeholder.
      return e.message
        ? `${e.stage ? `${e.stage}: ` : ""}${e.message.slice(0, 120)}`
        : e.stage || "working…";
  }
}
