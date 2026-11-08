import { createHash, createHmac } from "node:crypto";

/**
 * Header carrying this process's signed, resolved EventTrigger dispatch for one
 * Temporal-engine `/invoke` turn (ADR 0048, docs/event-triggers.md §5).
 *
 * This process matches events against its own EventTrigger registry and
 * forwards the RESULT -- forced target, tool input, params, the trigger's
 * readOnly and name. Each is a dispatch decision: a forced agent skips the
 * trigger's match rules, and a trigger-produced turn decides the
 * conversation's read-only mode. The engine's `/invoke` bearer token only says
 * "someone allowed to call /invoke", so these travel signed and bound to the
 * turn's session and prompt, never as body fields anything holding that token
 * could write. Verified by the engine's `rbac.VerifyDispatchAssertion`.
 */
export const DISPATCH_ASSERTION_HEADER = "x-orchestrator-dispatch-assertion";

const DEFAULT_TTL_SECONDS = 300;

export interface Dispatch {
  triggerName: string;
  forcedSkillId?: string;
  forcedAgentId?: string;
  forcedToolId?: string;
  toolInput?: string;
  readOnly?: boolean;
  params?: Record<string, string>;
}

/** Hex SHA-256 of a turn's request text, as bound into the assertion. */
export function requestDigest(request: string): string {
  return createHash("sha256").update(request, "utf8").digest("hex");
}

/**
 * Mints `<payload>.<signature>`, the same HMAC-SHA256 scheme as the sender and
 * caller-identity assertions. `typ` keeps it from being read as either of
 * those, which share the secret. The engine only decodes the payload (it never
 * re-encodes it to verify), so key order is not load-bearing here.
 */
export function mintDispatchAssertion(
  secret: string,
  dispatch: Dispatch,
  sessionId: string,
  request: string,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
): string {
  const payload = {
    typ: "dispatch",
    ...dispatch,
    sessionId,
    requestSha256: requestDigest(request),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}
