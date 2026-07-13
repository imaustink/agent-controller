import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard for a caller-supplied URL (ADR 0014). Even though a LocalTool runs
 * inside a sandboxed sidecar, a network-enabled tool that fetches an arbitrary
 * URL is a live SSRF vector — the sandbox's shared pod network namespace can
 * still reach in-cluster services and the node's metadata endpoint. This
 * mirrors tools/recipe-scraper/src/security/url-guard.ts: only http/https, and
 * every resolved address must be public.
 */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("only http/https URLs are allowed");
  }
  const host = url.hostname;
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true })).map((a) => a.address);
  if (addresses.length === 0) {
    throw new Error(`could not resolve host ${host}`);
  }
  for (const address of addresses) {
    if (isBlockedAddress(address)) {
      throw new Error(`blocked address ${address} (SSRF guard)`);
    }
  }
  return url;
}

/** True for loopback/private/link-local/CGNAT/metadata and IPv6 equivalents. */
export function isBlockedAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isBlockedV4(ip);
  if (family === 6) return isBlockedV6(ip);
  return true; // not a recognizable IP -> deny
}

function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a >= 224) return true; // multicast/reserved
  return false;
}

function isBlockedV6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === "::1" || lower === "::") return true; // loopback / unspecified
  if (lower.startsWith("fe80")) return true; // link-local
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local fc00::/7
  // IPv4-mapped (::ffff:a.b.c.d) — re-check the embedded v4.
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isBlockedV4(mapped[1] as string);
  return false;
}
