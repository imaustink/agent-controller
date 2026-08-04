/**
 * Parses a minimal subset of OpenSSH's ssh_config(5) grammar: "Host
 * <pattern...>" blocks, each optionally followed by HostName/User/Port
 * lines. Every other directive (IdentityFile, ProxyJump, Ciphers, ...) is
 * intentionally ignored -- this tool's identity is always the
 * secretEnv-injected SSH_PRIVATE_KEY (see config.ts), never something a
 * config file should be able to redirect.
 *
 * This is independent of, and does not require, the SSH_ALLOWED_HOSTS
 * allowlist (see target.ts) -- a config file supplies alias -> connection
 * details resolution; whether a resolved target is actually permitted is a
 * separate, optional concern.
 */

export interface SshConfigEntry {
  /** Space-separated Host patterns from a single "Host ..." line. Supports
   * the two OpenSSH wildcards ("*" and "?"); negated patterns ("!pattern")
   * are not supported. */
  patterns: string[];
  hostName?: string;
  user?: string;
  port?: number;
}

export function parseSshConfig(raw: string): SshConfigEntry[] {
  const entries: SshConfigEntry[] = [];
  let current: SshConfigEntry | undefined;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const sepIdx = line.search(/[\s=]/);
    if (sepIdx === -1) continue;
    const key = line.slice(0, sepIdx).toLowerCase();
    const value = line.slice(sepIdx + 1).replace(/^=\s*/, "").trim();
    if (!value) continue;

    if (key === "host") {
      current = { patterns: value.split(/\s+/) };
      entries.push(current);
      continue;
    }
    if (!current) continue; // A directive before any "Host" line isn't valid ssh_config; skip it.

    if (key === "hostname") current.hostName = value;
    else if (key === "user") current.user = value;
    else if (key === "port") {
      const port = Number(value);
      if (Number.isInteger(port) && port > 0 && port <= 65535) current.port = port;
    }
    // Every other directive is silently ignored -- see file header.
  }

  return entries;
}

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export interface ResolvedAlias {
  /** Whether any Host block's pattern matched the alias at all -- distinct
   * from every field below being undefined, which can happen for a
   * legitimately matched block that sets none of HostName/User/Port. */
  matched: boolean;
  hostName?: string;
  user?: string;
  port?: number;
}

/**
 * Resolves an alias against parsed ssh_config entries, merging fields from
 * every matching Host block in file order (first match wins per field) --
 * the same semantics real ssh_config uses, e.g. a specific "Host kube0"
 * block earlier in the file plus a trailing "Host *" block supplying a
 * shared default User.
 */
export function resolveAlias(alias: string, entries: SshConfigEntry[]): ResolvedAlias {
  const result: ResolvedAlias = { matched: false };
  for (const entry of entries) {
    if (!entry.patterns.some((p) => patternToRegExp(p).test(alias))) continue;
    result.matched = true;
    if (result.hostName === undefined && entry.hostName !== undefined) result.hostName = entry.hostName;
    if (result.user === undefined && entry.user !== undefined) result.user = entry.user;
    if (result.port === undefined && entry.port !== undefined) result.port = entry.port;
  }
  return result;
}
