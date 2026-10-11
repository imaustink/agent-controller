import { createHmac } from "node:crypto";

/**
 * Header carrying integration-gateway's signed claim about WHO triggered a
 * webhook turn (docs/adr/0030 §6).
 *
 * MINTING side. The verifier is agent-orchestrator's
 * `src/rbac/sender-assertion.ts`; the two must agree byte-for-byte, which is
 * why this is a deliberate copy of ~30 lines of `node:crypto` rather than a
 * shared package -- neither app currently depends on the other, and adding a
 * package to share one HMAC would cost more than it saves.
 *
 * This gateway authenticates to `/invoke` with its own service token, so that
 * token says "the gateway is calling" and nothing about the human behind it.
 * The sender login therefore has to travel separately -- and signed, because
 * it selects the caller's principal and hence which stored credentials the run
 * receives. An unsigned field would let anything holding the gateway's token
 * name an arbitrary login and be handed that person's credentials.
 */
export const SENDER_ASSERTION_HEADER = "x-gateway-user-assertion";

/** How long a minted assertion stays valid. Seconds, not hours: it is created and consumed within one HTTP call. */
const DEFAULT_TTL_SECONDS = 300;

interface AssertionPayload {
  login: string;
  /** Unix seconds. */
  exp: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, payloadB64: string): string {
  return b64url(createHmac("sha256", secret).update(payloadB64).digest());
}

/**
 * Mints `<payload>.<signature>` for a login.
 *
 * Deliberately not a full JWT: both ends live in this repo, the only claims
 * needed are a login and an expiry, and hand-rolling HMAC here avoids adding a
 * JWT library to the gateway purely to agree with the orchestrator's. Same
 * no-new-dependency precedent as `githubApp.ts`'s JWT signing.
 */
export function mintSenderAssertion(secret: string, login: string, ttlSeconds = DEFAULT_TTL_SECONDS, now = Date.now()): string {
  const payload: AssertionPayload = { login, exp: Math.floor(now / 1000) + ttlSeconds };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}
