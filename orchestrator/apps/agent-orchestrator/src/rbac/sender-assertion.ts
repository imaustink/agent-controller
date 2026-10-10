import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Header carrying integration-gateway's signed claim about WHO triggered a
 * webhook turn (docs/adr/0030 §6).
 *
 * The gateway authenticates to `/invoke` with its own service token, so that
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

/**
 * Returns the asserted login, or `undefined` if the assertion is missing,
 * malformed, expired, or not signed by `secret`.
 *
 * Fails closed and silently, like every other resolver here (ADR 0004): a
 * caller that cannot prove who they are is simply treated as not having said,
 * which downstream means "no principal" rather than "someone else's principal".
 */
export function verifySenderAssertion(secret: string, assertion: string | undefined, now = Date.now()): string | undefined {
  if (!secret || !assertion) return undefined;
  const [payloadB64, signature] = assertion.split(".");
  if (!payloadB64 || !signature) return undefined;

  const expected = Buffer.from(sign(secret, payloadB64), "utf8");
  const actual = Buffer.from(signature, "utf8");
  // Length check first: timingSafeEqual throws on a length mismatch rather
  // than returning false.
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8")) as AssertionPayload;
    if (typeof payload.login !== "string" || !payload.login) return undefined;
    if (typeof payload.exp !== "number" || payload.exp * 1000 <= now) return undefined;
    return payload.login;
  } catch {
    return undefined;
  }
}
