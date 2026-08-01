import { createHmac, timingSafeEqual } from "node:crypto";

export interface OAuthStatePayload {
  provider: string;
  subject: string;
}

interface SignedStatePayload extends OAuthStatePayload {
  iat: number;
}

// Clock-skew allowance for a future-dated `iat`, mirroring the tolerance
// `githubApp.ts`'s `signAppJwt` already applies to GitHub App JWTs.
const CLOCK_SKEW_SECONDS = 60;

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function sign(payloadB64: string, secret: string): string {
  return base64url(createHmac("sha256", secret).update(payloadB64).digest());
}

/**
 * Signs a CSRF `state` payload for the OAuth authorization-code flow: a
 * minimal HMAC-SHA256-signed token (not a JWT — no `alg`/`typ` header
 * machinery needed since both signer and verifier are this same package).
 */
export function signState(payload: OAuthStatePayload, secret: string, now: number = Date.now()): string {
  const signed: SignedStatePayload = { ...payload, iat: Math.floor(now / 1000) };
  const payloadB64 = base64url(JSON.stringify(signed));
  const signatureB64 = sign(payloadB64, secret);
  return `${payloadB64}.${signatureB64}`;
}

/**
 * Verifies a `state` token produced by `signState`. Fails closed: every
 * failure mode (malformed shape, invalid base64/JSON, missing/non-string
 * fields, tampered payload or signature, expired or implausibly-future
 * `iat`) returns `undefined` rather than throwing or returning partial data
 * — mirroring `OidcIdentityResolver.resolve`'s fail-closed discipline
 * (apps/agent-orchestrator/src/rbac/oidc-identity-resolver.ts) so a caller
 * can never mistake a rejected token for a verified one.
 */
export function verifyState(
  token: string,
  secret: string,
  maxAgeSeconds: number,
  now: number = Date.now(),
): OAuthStatePayload | undefined {
  const parts = token.split(".");
  if (parts.length !== 2) return undefined;
  const [payloadB64, signatureB64] = parts;
  if (!payloadB64 || !signatureB64) return undefined;

  let expectedSignature: Buffer;
  let providedSignature: Buffer;
  try {
    expectedSignature = Buffer.from(sign(payloadB64, secret), "base64url");
    providedSignature = Buffer.from(signatureB64, "base64url");
  } catch {
    return undefined;
  }
  if (expectedSignature.length !== providedSignature.length) return undefined;
  if (!timingSafeEqual(expectedSignature, providedSignature)) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString());
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { provider, subject, iat } = parsed as Record<string, unknown>;
  if (typeof provider !== "string" || typeof subject !== "string" || typeof iat !== "number") return undefined;

  const nowSeconds = Math.floor(now / 1000);
  if (iat > nowSeconds + CLOCK_SKEW_SECONDS) return undefined;
  if (nowSeconds - iat > maxAgeSeconds) return undefined;

  return { provider, subject };
}
