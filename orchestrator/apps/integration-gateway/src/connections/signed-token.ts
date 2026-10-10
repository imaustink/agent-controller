import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * A compact HMAC-signed, expiring JSON token: `<payload b64url>.<sig b64url>`.
 *
 * Used for the Connections page's own browser state (the session cookie and
 * the in-flight OIDC login), which is why it is not `signState` from
 * `@controller-agent/github-app-auth`: that one is fixed to a
 * `{provider, subject}` payload for OAuth `state`, and these carry other fields.
 *
 * `purpose` is folded into the MAC so a token minted for one use (a login
 * cookie, say) can never be replayed as another (a session) even though both
 * are signed with the same key.
 */
export function signToken(payload: Record<string, unknown>, purpose: string, key: Buffer, expiresAtMs: number): string {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(expiresAtMs / 1000) })).toString("base64url");
  return `${body}.${mac(body, purpose, key)}`;
}

/** Verifies a {@link signToken} token. Fails closed: any defect, or expiry, is `undefined`. */
export function verifyToken(
  token: string,
  purpose: string,
  key: Buffer,
  nowMs: number = Date.now(),
): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  const [body, sig] = parts as [string, string];
  const expected = Buffer.from(mac(body, purpose, key), "base64url");
  const provided = Buffer.from(sig, "base64url");
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const exp = (parsed as { exp?: unknown }).exp;
  if (typeof exp !== "number" || exp * 1000 <= nowMs) return undefined;
  return parsed as Record<string, unknown>;
}

/**
 * Derives a purpose-specific key from an existing secret, so the page needs no
 * new Secret key of its own -- one more value for an operator to provision is
 * one more way for the deploy to come up half-configured.
 */
export function deriveKey(secret: string, label: string): Buffer {
  return createHmac("sha256", secret).update(`controller-agent/${label}`).digest();
}

function mac(body: string, purpose: string, key: Buffer): string {
  return createHmac("sha256", key).update(`${purpose}.${body}`).digest("base64url");
}
