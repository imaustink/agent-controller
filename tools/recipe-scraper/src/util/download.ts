import { config } from "../config.js";
import { assertUrlAllowed, UrlGuardError } from "../security/url-guard.js";

export interface GuardedFetchOptions {
  method?: "GET" | "HEAD";
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fetch that re-validates the target against the SSRF guard on every redirect
 * hop. `redirect: "manual"` is essential: without it, `fetch` would silently
 * follow a redirect from a public host to an internal one.
 */
export async function guardedFetch(
  rawUrl: string,
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const method = options.method ?? "GET";
  const timeoutMs = options.timeoutMs ?? config.fetchTimeoutMs;
  let current = rawUrl;

  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    const safe = await assertUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(safe.url, {
        method,
        headers: { "user-agent": config.userAgent, ...options.headers },
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    const isRedirect = res.status >= 300 && res.status < 400;
    const location = res.headers.get("location");
    if (isRedirect && location) {
      current = new URL(location, safe.url).toString();
      continue;
    }
    return res;
  }

  throw new UrlGuardError(`Exceeded ${config.maxRedirects} redirects`);
}

export interface DownloadResult {
  bytes: Buffer;
  contentType: string;
}

/**
 * Downloads a URL into memory, aborting as soon as the byte cap is exceeded so
 * a malicious server cannot exhaust memory with an unbounded body.
 */
export async function downloadBytes(
  rawUrl: string,
  maxBytes: number,
): Promise<DownloadResult> {
  const res = await guardedFetch(rawUrl);
  if (!res.ok) {
    throw new Error(`Download failed with HTTP ${res.status}`);
  }

  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) {
    throw new Error(`Content-Length ${declared} exceeds cap ${maxBytes}`);
  }

  const contentType = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
  const body = res.body;
  if (!body) throw new Error("Response had no body");

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`Download exceeded cap of ${maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }

  return { bytes: Buffer.concat(chunks), contentType };
}
