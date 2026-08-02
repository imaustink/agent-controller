/**
 * Resolves a caller-supplied target string into an exact user/host/port to
 * dial, from two INDEPENDENT and each individually optional inputs:
 *
 *   - SSH_CONFIG (sshconfig.ts): alias -> HostName/User/Port resolution,
 *     ssh_config-shaped. Lets an alias like "kube0" resolve the way it
 *     already does in the operator's own ~/.ssh/config, instead of forcing
 *     every caller to spell out "ubuntu@192.168.1.59".
 *   - SSH_ALLOWED_HOSTS (config.ts): a fixed allowlist restricting which
 *     RESOLVED targets may be dialed at all. Independent of SSH_CONFIG --
 *     an operator can allowlist raw "user@host" targets with no config file
 *     at all, or provide a config file (for alias resolution) without an
 *     allowlist (trusting the config file's own curated Host list as the
 *     boundary instead).
 *
 * At least one of the two must be configured (enforced in index.ts's
 * startup check, not here) -- resolving with neither would mean this tool
 * dials whatever "user@host" string a caller supplies, with no boundary at
 * all.
 */

import { resolveAlias, type SshConfigEntry } from "./sshconfig.js";

export class BlockedTargetError extends Error {}

export interface Target {
  user: string;
  host: string;
  port: number;
}

/** The subset of AppConfig this module needs -- kept as its own interface
 * (AppConfig satisfies it structurally) rather than importing config.ts
 * directly, so sshconfig.ts/target.ts stay independently testable without
 * pulling in env-var parsing. */
export interface TargetResolutionConfig {
  sshConfigEntries: SshConfigEntry[];
  defaultUser: string | undefined;
  allowedHosts: Target[] | null;
}

/** Every user/host token must match this charset: no shell metacharacters,
 * no quotes, no whitespace -- nothing that could change meaning once it
 * reaches the remote login shell (see allowlist.ts's file header for why
 * that matters for ssh specifically). */
const SAFE_TOKEN = /^[A-Za-z0-9._\-]+$/;

interface LiteralTarget {
  user?: string;
  host: string;
  port?: number;
}

/** Parses "host", "user@host", or "user@host:port" -- no ssh_config
 * involvement, just splitting the caller's literal string. `host` may also
 * be a bare alias meant to be looked up in SSH_CONFIG. */
function parseLiteral(raw: string): LiteralTarget | undefined {
  const atIdx = raw.indexOf("@");
  const userPart = atIdx === -1 ? undefined : raw.slice(0, atIdx);
  const hostPort = atIdx === -1 ? raw : raw.slice(atIdx + 1);
  if (userPart !== undefined && !SAFE_TOKEN.test(userPart)) return undefined;

  const colonIdx = hostPort.lastIndexOf(":");
  const host = colonIdx === -1 ? hostPort : hostPort.slice(0, colonIdx);
  const portStr = colonIdx === -1 ? undefined : hostPort.slice(colonIdx + 1);
  if (!host || !SAFE_TOKEN.test(host)) return undefined;

  let port: number | undefined;
  if (portStr !== undefined) {
    port = Number(portStr);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;
  }
  return { user: userPart, host, port };
}

/**
 * Resolves a caller-supplied target string to the exact {user, host, port}
 * to dial, applying SSH_CONFIG alias resolution and the SSH_ALLOWED_HOSTS
 * allowlist, whichever of the two are configured. Throws
 * {@link BlockedTargetError} if the target can't be resolved to a user, or
 * if an allowlist is configured and the resolved target isn't on it.
 */
export function resolveTarget(rawTarget: string, cfg: TargetResolutionConfig): Target {
  const literal = parseLiteral(rawTarget);
  if (!literal) {
    throw new BlockedTargetError(`"${rawTarget}" is not a valid target (expected "host", "user@host", or an alias).`);
  }

  const alias = cfg.sshConfigEntries.length > 0 ? resolveAlias(literal.host, cfg.sshConfigEntries) : { matched: false };

  const host = (alias.hostName ?? literal.host).toLowerCase();
  const user = (literal.user ?? alias.user ?? cfg.defaultUser)?.toLowerCase();
  const port = literal.port ?? alias.port ?? 22;

  if (!user) {
    throw new BlockedTargetError(
      `No user found for target "${rawTarget}" -- set it in the target string ("user@host"), in SSH_CONFIG's matching Host block, or via SSH_DEFAULT_USER.`,
    );
  }

  const resolved: Target = { user, host, port };

  if (cfg.allowedHosts) {
    const match = cfg.allowedHosts.find(
      (entry) => entry.host === resolved.host && entry.user === resolved.user && entry.port === resolved.port,
    );
    if (!match) {
      throw new BlockedTargetError(
        `Target "${resolved.user}@${resolved.host}:${resolved.port}" is not in SSH_ALLOWED_HOSTS. Allowed: ${cfg.allowedHosts
          .map((h) => `${h.user}@${h.host}:${h.port}`)
          .join(", ")}.`,
      );
    }
  }

  return resolved;
}
