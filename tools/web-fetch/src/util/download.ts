import { config } from "../config.js";
import { assertUrlAllowed, UrlGuardError } from "../security/url-guard.js";

/**
 * Fetch that re-validates the target against the SSRF guard on every redirect
 * hop. `redirect: "manual"` is essential: without it, `fetch` would silently
 * follow a redirect from a public host to an internal one (same pattern as
 * tools/recipe-scraper/src/util/download.ts).
 */
export async function guardedFetch(rawUrl: string): Promise<Response> {
  let current = rawUrl;

  for (let hop = 0; hop <= config.maxRedirects; hop++) {
    const safe = await assertUrlAllowed(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.fetchTimeoutMs);
    let res: Response;
    try {
      res = await fetch(safe.url, {
        headers: { "user-agent": config.userAgent, accept: "text/html,application/xhtml+xml" },
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
  text: string;
  contentType: string;
}

/**
 * Downloads a URL into memory as text, aborting as soon as the byte cap is
 * exceeded so a malicious or oversized page cannot exhaust memory.
 */
export async function downloadText(rawUrl: string): Promise<DownloadResult> {
  const res = await guardedFetch(rawUrl);
  if (!res.ok) {
    throw new Error(`Fetch failed with HTTP ${res.status}`);
  }

  const declared = res.headers.get("content-length");
  if (declared && Number(declared) > config.maxBytes) {
    throw new Error(`Content-Length ${declared} exceeds cap ${config.maxBytes}`);
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
      if (total > config.maxBytes) {
        await reader.cancel();
        throw new Error(`Download exceeded cap of ${config.maxBytes} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  }

  return { text: Buffer.concat(chunks).toString("utf-8"), contentType };
}
