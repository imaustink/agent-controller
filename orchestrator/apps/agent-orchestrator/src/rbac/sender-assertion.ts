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

/**
 * What integration-gateway vouches for about a webhook sender (docs/adr/0049
 * §5). `login` is all a pre-0049 assertion carries; the rest is additive.
 * `subject` is the one subject the sender's account is linked under, carried
 * only with `subjectStatus: "linked"`.
 */
export interface SenderClaims {
  login: string;
  accountId?: string;
  subject?: string;
  subjectStatus?: "linked" | "unlinked" | "ambiguous" | "unavailable";
}

interface AssertionPayload extends SenderClaims {
  /** Unix seconds. */
  exp: number;
}

const SUBJECT_STATUSES = new Set(["linked", "unlinked", "ambiguous", "unavailable"]);

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
export function mintSenderAssertion(
  secret: string,
  sender: string | SenderClaims,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
): string {
  const claims: SenderClaims = typeof sender === "string" ? { login: sender } : sender;
  const payload: AssertionPayload = {
    login: claims.login,
    ...(claims.accountId ? { accountId: claims.accountId } : {}),
    ...(claims.subjectStatus ? { subjectStatus: claims.subjectStatus } : {}),
    ...(claims.subjectStatus === "linked" && claims.subject ? { subject: claims.subject } : {}),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
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
  return verifySenderClaims(secret, assertion, now)?.login;
}

/**
 * {@link verifySenderAssertion}, returning every claim. A subject is only
 * ever returned with `subjectStatus: "linked"`.
 */
export function verifySenderClaims(secret: string, assertion: string | undefined, now = Date.now()): SenderClaims | undefined {
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
    const claims: SenderClaims = { login: payload.login };
    if (typeof payload.accountId === "string" && payload.accountId) claims.accountId = payload.accountId;
    if (typeof payload.subjectStatus === "string" && SUBJECT_STATUSES.has(payload.subjectStatus)) {
      claims.subjectStatus = payload.subjectStatus;
      if (payload.subjectStatus === "linked" && typeof payload.subject === "string" && payload.subject) claims.subject = payload.subject;
    }
    return claims;
  } catch {
    return undefined;
  }
}
