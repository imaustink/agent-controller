import { createHmac } from "node:crypto";
import type { Event } from "./event.js";
import type { Sink } from "./sink.js";

export class CallbackConfigError extends Error {}

export interface CallbackOptions {
  url: string;
  /** Optional shared secret; when set, bodies are HMAC-SHA256 signed. */
  secret?: string | undefined;
  /**
   * Allowlist of hosts the callback may target. When non-empty, the target
   * host must match. This is intentionally NOT an SSRF guard: a callback
   * legitimately points at a private/cluster address owned by the parent.
   */
  allowedHosts?: string[];
  /** Total delivery attempts per event (>= 1). */
  maxRetries?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests. */
  sleepImpl?: (ms: number) => Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Delivers each event to a parent-provided HTTP endpoint.
 *
 * Security contract:
 * - The URL MUST come from the trusted parent (env/config), never from
 *   scraped/untrusted content — a content-derived URL would be an SSRF/exfil
 *   vector.
 * - Only http/https is allowed, and the host is checked against an allowlist.
 * - Bodies are optionally HMAC-signed so the parent can verify authenticity.
 * - Every request carries an `Idempotency-Key` (`job_id:seq`) so at-least-once
 *   retries are safe to dedupe.
 *
 * Large/binary payloads never travel here; events reference them by URI.
 */
export class CallbackSink<TResult = unknown> implements Sink<TResult> {
  private readonly url: URL;
  private readonly secret: string | undefined;
  private readonly maxRetries: number;
  private readonly doFetch: typeof fetch;
  private readonly doSleep: (ms: number) => Promise<void>;

  constructor(opts: CallbackOptions) {
    let parsed: URL;
    try {
      parsed = new URL(opts.url);
    } catch {
      throw new CallbackConfigError(`Invalid callback URL: ${opts.url}`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CallbackConfigError(`Callback URL must be http(s): ${parsed.protocol}`);
    }
    const allowed = opts.allowedHosts ?? [];
    if (allowed.length > 0 && !allowed.includes(parsed.hostname.toLowerCase())) {
      throw new CallbackConfigError(`Callback host not in allowlist: ${parsed.hostname}`);
    }

    this.url = parsed;
    this.secret = opts.secret;
    this.maxRetries = Math.max(1, opts.maxRetries ?? 3);
    this.doFetch = opts.fetchImpl ?? fetch;
    this.doSleep = opts.sleepImpl ?? sleep;
  }

  async emit(event: Event<TResult>): Promise<void> {
    const body = JSON.stringify(event);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "idempotency-key": `${event.job_id}:${event.seq}`,
    };
    if (this.secret) {
      headers["x-signature"] = `sha256=${createHmac("sha256", this.secret).update(body).digest("hex")}`;
    }

    let lastErr: unknown;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      if (attempt > 0) await this.doSleep(2 ** (attempt - 1) * 200);
      try {
        const res = await this.doFetch(this.url.toString(), { method: "POST", headers, body });
        if (res.ok) return;
        lastErr = new Error(`Callback returned HTTP ${res.status}`);
      } catch (err) {
        lastErr = err;
      }
    }
    throw new Error(
      `Callback delivery failed after ${this.maxRetries} attempts: ${(lastErr as Error)?.message ?? lastErr}`,
    );
  }

  async close(): Promise<void> {
    // Stateless; nothing to release.
  }
}
