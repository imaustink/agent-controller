import { createHmac } from "node:crypto";

/**
 * Header carrying this process's signed claim about which per-request
 * identity it already resolved for a chat/invoke turn -- its OWN
 * OIDC/static/forwarded-user-JWT resolution, not the Temporal engine
 * gateway's bearer-token map.
 *
 * Every internal hop to that gateway otherwise authenticates with ONE shared
 * service token (or none), so every caller resolves to the same subject
 * regardless of which human is actually chatting -- collapsing every Open
 * WebUI user onto one identity, the same bug class ADR 0030 fixed for
 * webhooks via `SENDER_ASSERTION_HEADER`. This is that fix generalized: a
 * resolved SUBJECT (and its roles) rather than a GitHub login, signed for the
 * same reason -- an unsigned field would let anything holding the gateway's
 * token name an arbitrary subject.
 */
export const CALLER_IDENTITY_HEADER = "x-gateway-caller-identity";

const DEFAULT_TTL_SECONDS = 300;

interface CallerIdentityPayload {
  subject: string;
  roles: string[];
  /**
   * True only when this subject came from a per-request signed identity
   * (Open WebUI's forwarded-user JWT, or real OIDC) -- never from a shared
   * static/bearer token, which can resolve successfully yet still be one
   * value every caller presents. Gates whether the engine will look up a
   * GitHub-link-based principal upgrade at all (ADR 0030 §6/0031): doing that
   * for a shared subject would let whoever links first share their
   * credentials with everyone else who happens to authenticate the same way.
   */
  perUser: boolean;
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
 * Mints `<payload>.<signature>` for a resolved subject/roles pair. Same HMAC
 * scheme as `mintSenderAssertion`, deliberately a separate payload/header:
 * this asserts a resolved caller identity, not a GitHub login.
 */
export function mintCallerIdentityAssertion(
  secret: string,
  subject: string,
  roles: string[],
  perUser: boolean,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  now = Date.now(),
): string {
  const payload: CallerIdentityPayload = { subject, roles, perUser, exp: Math.floor(now / 1000) + ttlSeconds };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  return `${payloadB64}.${sign(secret, payloadB64)}`;
}
