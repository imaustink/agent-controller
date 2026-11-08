import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { WebhookVerify } from "@controller-agent/event-triggers";

/**
 * Webhook verification for an `EventSource` (ADR 0048, docs/event-triggers.md
 * §1). Every scheme runs on the RAW request bytes, before anything parses
 * them -- a forged body must never reach a JSON parser, a CEL expression or
 * the orchestrator. There is deliberately no `none` scheme: a source that
 * cannot prove its events came from where it claims fails closed.
 *
 * Every function here returns a verdict instead of throwing, and never puts
 * the secret or the presented credential into the reason (the reason is
 * logged).
 */

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/** Slack rejects requests older than this; so do we (replay window). */
export const SLACK_MAX_SKEW_SECONDS = 300;

const SLACK_SIGNATURE_HEADER = "x-slack-signature";
const SLACK_TIMESTAMP_HEADER = "x-slack-request-timestamp";
const DEFAULT_BEARER_HEADER = "authorization";
const HEX_SHA256 = /^[0-9a-fA-F]{64}$/;

/**
 * The header carrying the credential for `verify` -- removed from the
 * envelope's `headers` (on top of `authorization`/`cookie`, which
 * `normalizeHeaders` always drops) so a signature or shared secret is never
 * handed to CEL, the orchestrator, or an agent's prompt.
 */
export function verifyHeaderName(verify: WebhookVerify): string {
  switch (verify.scheme) {
    case "slackV0":
      return (verify.header || SLACK_SIGNATURE_HEADER).toLowerCase();
    case "bearer":
      return (verify.header || DEFAULT_BEARER_HEADER).toLowerCase();
    case "hmacSha256":
    default:
      return (verify.header ?? "").toLowerCase();
  }
}

/**
 * A single header value. A header sent more than once is ambiguous about
 * which copy is the credential, so it is treated as absent (fail closed)
 * rather than guessing.
 */
function singleHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  if (!name) return undefined;
  const value = headers[name.toLowerCase()];
  if (Array.isArray(value)) return value.length === 1 ? value[0] : undefined;
  return value;
}

/** HMAC-SHA256 of `data`, compared against `providedHex` in constant time over the raw digest bytes. */
function hmacHexMatches(secret: string, data: Buffer, providedHex: string): boolean {
  // Shape-checked first so Buffer.from(..., "hex") can't silently truncate a
  // malformed value into something shorter (it stops at the first non-hex
  // character). The length is public (always 32 bytes), so rejecting a wrong
  // length early leaks nothing.
  if (!HEX_SHA256.test(providedHex)) return false;
  const expected = createHmac("sha256", secret).update(data).digest();
  return timingSafeEqual(expected, Buffer.from(providedHex, "hex"));
}

/**
 * Constant-time string equality for secrets of unknown length: both sides are
 * hashed to a fixed 32 bytes first, so neither the comparison's duration nor
 * an early length mismatch reveals how long (or how much of) the secret is.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

/**
 * Verifies one request against its source's `verify` block. `secret` is the
 * resolved `verify.secretRef` value; `undefined` or empty (the Secret or key is
 * missing, or unreadable) FAILS verification -- an HMAC keyed with "" is
 * forgeable by anyone, and a missing secret is a misconfiguration to surface
 * as 401s, not to paper over.
 */
export function verifyWebhookRequest(
  verify: WebhookVerify,
  secret: string | undefined,
  headers: IncomingHttpHeaders,
  rawBody: Buffer,
  now: Date = new Date(),
): VerifyResult {
  if (!secret) return { ok: false, reason: "verification secret unavailable" };

  switch (verify.scheme) {
    case "hmacSha256": {
      const header = verifyHeaderName(verify);
      if (!header) return { ok: false, reason: "hmacSha256 source has no signature header configured" };
      const provided = singleHeader(headers, header);
      if (!provided) return { ok: false, reason: `missing ${header}` };
      const prefix = verify.prefix ?? "";
      if (!provided.startsWith(prefix)) return { ok: false, reason: `${header} lacks the expected prefix` };
      return hmacHexMatches(secret, rawBody, provided.slice(prefix.length))
        ? { ok: true }
        : { ok: false, reason: `${header} mismatch` };
    }

    case "slackV0": {
      // https://api.slack.com/authentication/verifying-requests-from-slack:
      // v0=hex(hmac(secret, "v0:" + timestamp + ":" + rawBody)). The
      // timestamp is part of what's signed AND bounded, so a captured request
      // can't be replayed outside the window.
      const header = verifyHeaderName(verify);
      const provided = singleHeader(headers, header);
      const timestamp = singleHeader(headers, SLACK_TIMESTAMP_HEADER);
      if (!provided) return { ok: false, reason: `missing ${header}` };
      if (!timestamp || !/^\d{1,12}$/.test(timestamp)) return { ok: false, reason: `missing or malformed ${SLACK_TIMESTAMP_HEADER}` };
      const skew = Math.abs(Math.floor(now.getTime() / 1000) - Number(timestamp));
      if (skew > SLACK_MAX_SKEW_SECONDS) return { ok: false, reason: `${SLACK_TIMESTAMP_HEADER} outside the ${SLACK_MAX_SKEW_SECONDS}s window` };
      if (!provided.startsWith("v0=")) return { ok: false, reason: `${header} is not a v0 signature` };
      const basestring = Buffer.concat([Buffer.from(`v0:${timestamp}:`, "utf8"), rawBody]);
      return hmacHexMatches(secret, basestring, provided.slice(3))
        ? { ok: true }
        : { ok: false, reason: `${header} mismatch` };
    }

    case "bearer": {
      // The default `authorization` header carries "Bearer <secret>"; any
      // other header carries the raw secret (e.g. GitLab's X-Gitlab-Token).
      const header = verifyHeaderName(verify);
      const provided = singleHeader(headers, header);
      if (!provided) return { ok: false, reason: `missing ${header}` };
      const expected = header === DEFAULT_BEARER_HEADER ? `Bearer ${secret}` : secret;
      return constantTimeEquals(provided, expected) ? { ok: true } : { ok: false, reason: `${header} mismatch` };
    }

    default:
      return { ok: false, reason: `unsupported verify scheme ${JSON.stringify((verify as { scheme?: unknown }).scheme)}` };
  }
}

/**
 * Slack's Events API endpoint handshake: a signed POST of
 * `{"type":"url_verification","challenge":"..."}` that must be answered with
 * the challenge, synchronously. Returns the challenge when `body` is one;
 * the caller answers it and relays nothing (it is not an event).
 */
export function slackUrlVerificationChallenge(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const { type, challenge } = body as { type?: unknown; challenge?: unknown };
  return type === "url_verification" && typeof challenge === "string" ? challenge : undefined;
}
