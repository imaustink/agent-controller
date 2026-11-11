import { randomBytes } from "node:crypto";

/**
 * W3C trace context for one webhook delivery (docs/adr/0050 §4). This process
 * exports no spans of its own; it only makes the delivery and the turn it
 * starts ONE trace, by minting a `traceparent` (or continuing a valid inbound
 * one) and forwarding it on every hop to agent-orchestrator, which forwards it
 * to the engine, whose spans carry it from there.
 */
export const TRACEPARENT_HEADER = "traceparent";

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

/** The trace id of a valid version-00 traceparent, else undefined. */
export function traceIdOf(traceparent: string | undefined): string | undefined {
  const m = traceparent ? TRACEPARENT.exec(traceparent.trim()) : null;
  if (!m || m[1] === ZERO_TRACE || m[2] === ZERO_SPAN) return undefined;
  return m[1];
}

/**
 * A traceparent for a new hop: a child of `inbound` when it is valid (same
 * trace, fresh span id), else the root of a new sampled trace.
 */
export function nextTraceparent(inbound?: string): string {
  const traceId = traceIdOf(inbound) ?? randomBytes(16).toString("hex");
  return `00-${traceId}-${randomBytes(8).toString("hex")}-01`;
}
