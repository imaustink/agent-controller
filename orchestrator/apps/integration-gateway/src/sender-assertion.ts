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

/**
 * Whether a verified sender resolved to a subject their links live under
 * (docs/adr/0049 §5): `linked` (exactly one), `unlinked` (none), `ambiguous`
 * (more than one), or `unavailable` (the lookup failed or is not configured).
 */
export type SenderSubjectStatus = "linked" | "unlinked" | "ambiguous" | "unavailable";

/**
 * What the gateway vouches for about a webhook sender. `login` is all an older
 * verifier reads; the rest is additive (the signature covers the received
 * bytes and verifiers only decode, so extra fields cannot break one).
 */
export interface SenderClaims {
  login: string;
  /** The provider's immutable account id, when the source extracts one. */
  accountId?: string;
  /** The subject the account is linked under; only with `subjectStatus: "linked"`. */
  subject?: string;
  subjectStatus?: SenderSubjectStatus;
}

interface AssertionPayload extends SenderClaims {
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
    // A subject is only ever vouched for when it is THE one linked subject.
    ...(claims.subjectStatus === "linked" && claims.subject ? { subject: claims.subject } : {}),
    exp: Math.floor(now / 1000) + ttlSeconds,
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}
