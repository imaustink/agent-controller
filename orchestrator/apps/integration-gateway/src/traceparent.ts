import { randomBytes } from "node:crypto";

/**
 * W3C trace context helpers (docs/adr/0050 §4). A webhook delivery and the
 * turn it starts are ONE trace: this process continues a valid inbound
 * `traceparent` (or roots a new trace) and forwards its own span's context to
 * agent-orchestrator, which forwards its own to the engine. See telemetry.ts
 * for the spans themselves.
 */
export const TRACEPARENT_HEADER = "traceparent";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** The parts of a valid version-00 traceparent, else undefined. */
export function parseTraceparent(traceparent: string | undefined): { traceId: string; spanId: string; flags: number } | undefined {
  const m = traceparent ? TRACEPARENT.exec(traceparent.trim()) : null;
  if (!m || m[1] === ZERO_TRACE || m[2] === ZERO_SPAN) return undefined;
  return { traceId: m[1]!, spanId: m[2]!, flags: parseInt(m[3]!, 16) };
}

/** The trace id of a valid version-00 traceparent, else undefined. */
export function traceIdOf(traceparent: string | undefined): string | undefined {
  return parseTraceparent(traceparent)?.traceId;
}

/**
 * A traceparent for a new hop: a child of `inbound` when it is valid (same
 * trace, fresh span id), else the root of a new sampled trace.
 */
export function nextTraceparent(inbound?: string): string {
  const traceId = traceIdOf(inbound) ?? randomBytes(16).toString("hex");
  return `00-${traceId}-${randomBytes(8).toString("hex")}-01`;
}
