import { promises as dns } from "node:dns";
import net from "node:net";

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Thrown whenever a URL fails the SSRF / scheme checks. */
export class UrlGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UrlGuardError";
  }
}

export interface SafeUrl {
  url: URL;
  /** Resolved IP addresses that all passed the block-list check. */
  addresses: string[];
}

function ipv4ToLong(ip: string): number {
  return (
    ip
      .split(".")
      .reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0
  );
}

/**
 * Blocks loopback, private, link-local, CGNAT, benchmarking, documentation,
 * multicast, reserved and broadcast IPv4 ranges. Critically this includes
 * 169.254.0.0/16 which covers cloud metadata endpoints (169.254.169.254).
 */
function isBlockedIPv4(ip: string): boolean {
  const value = ipv4ToLong(ip);
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
    ["255.255.255.255", 32],
  ];
  return ranges.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return (value & mask) === (ipv4ToLong(base) & mask);
  });
}

function isBlockedIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible addresses.
  const mappedMatch = norm.match(/^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (mappedMatch && mappedMatch[1] && net.isIPv4(mappedMatch[1])) {
    return isBlockedIPv4(mappedMatch[1]);
  }
  if (norm === "::1" || norm === "::") return true; // loopback / unspecified
  if (norm.startsWith("fe80")) return true; // link-local
  if (norm.startsWith("fec0")) return true; // deprecated site-local
  if (norm.startsWith("fc") || norm.startsWith("fd")) return true; // unique local
  if (norm.startsWith("ff")) return true; // multicast
  if (norm.startsWith("2001:db8")) return true; // documentation
  if (norm.startsWith("64:ff9b")) return false; // NAT64 of public v4 handled elsewhere
  return false;
}

/** Returns true if the literal IP is in a range we must never connect to. */
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIPv4(ip);
  if (net.isIPv6(ip)) return isBlockedIPv6(ip);
  return true; // Unknown format → fail closed.
}

/**
 * Validates a URL for scheme and resolves its host, ensuring every resolved
 * address is publicly routable. Note: this mitigates but cannot fully close a
 * DNS-rebinding (TOCTOU) window — the container's egress firewall is the
 * required backstop. See run.sh / README for the hardened run contract.
 */
export async function assertUrlAllowed(raw: string): Promise<SafeUrl> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlGuardError(`Invalid URL: ${raw}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new UrlGuardError(`Blocked protocol: ${url.protocol}`);
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new UrlGuardError("URL is missing a hostname");

  let addresses: string[];
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    let records: Array<{ address: string }>;
    try {
      records = await dns.lookup(host, { all: true });
    } catch {
      throw new UrlGuardError(`DNS resolution failed for host: ${host}`);
    }
    addresses = records.map((r) => r.address);
  }

  if (addresses.length === 0) {
    throw new UrlGuardError(`No addresses resolved for host: ${host}`);
  }

  for (const address of addresses) {
    if (isBlockedIp(address)) {
      throw new UrlGuardError(
        `Blocked non-public address ${address} for host ${host}`,
      );
    }
  }

  return { url, addresses };
}
