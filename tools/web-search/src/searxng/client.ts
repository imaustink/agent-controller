import { SearxngResponseSchema, type SearchResult } from "../schema.js";

export interface SearxngConfig {
  /** Fixed, trusted server-side configuration -- never derived from tool input. */
  baseUrl: string;
  fetchTimeoutMs: number;
}

export class SearxngSearchError extends Error {}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow redirects: the target host is fixed configuration, not
    // something we want silently re-pointed by a 3xx response.
    return await fetch(url, {
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/**
 * Queries the in-cluster SearXNG instance's JSON API
 * (https://docs.searxng.org/, `?format=json`, enabled specifically for this
 * caller -- see charts/agent-controller/templates/searxng.yaml) and returns
 * its results, narrowed to title/url/content.
 */
export async function search(query: string, cfg: SearxngConfig): Promise<SearchResult[]> {
  const url = new URL("/search", cfg.baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  let res: Response;
  try {
    res = await fetchWithTimeout(url.toString(), cfg.fetchTimeoutMs);
  } catch (err) {
    throw new SearxngSearchError(`Request to SearXNG failed: ${(err as Error).message}`);
  }

  if (!res.ok) {
    throw new SearxngSearchError(`SearXNG returned ${res.status}: ${await safeText(res)}`);
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new SearxngSearchError(`SearXNG response was not valid JSON: ${(err as Error).message}`);
  }

  const parsed = SearxngResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new SearxngSearchError(`SearXNG response did not match the expected shape: ${parsed.error.message}`);
  }

  return parsed.data.results;
}
