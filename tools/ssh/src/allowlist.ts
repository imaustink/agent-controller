/**
 * Defense-in-depth validation of a caller-supplied "<target> <remote
 * command...>" line, on top of the real authorization boundary: the fixed
 * SSH_ALLOWED_HOSTS list in config.ts (which host this tool's shared key is
 * even allowed to dial) and whatever `authorized_keys`/sudoers restrictions
 * exist on the target boxes themselves, which this tool has no visibility
 * into and cannot assume.
 *
 * This matters more here than in tools/kubectl-readonly or tools/github:
 * `spawn("ssh", [..., "user@host", ...remoteArgv])` never runs a local
 * shell, but OpenSSH's client concatenates remoteArgv with spaces and hands
 * that single string to the REMOTE side's login shell (`sh -c "<string>"`)
 * unless the target's authorized_keys forces a fixed command. So unlike
 * kubectl/gh (single local process, no shell anywhere), a caller-supplied
 * `;`, `|`, `$(...)`, backtick, or redirection here is a real remote shell
 * injection primitive, not just noise -- every token is restricted to a
 * plain-argument charset (see SAFE_TOKEN) in addition to the top-level
 * command allowlist.
 *
 * Top-level commands are an explicit ALLOWLIST of read-only diagnostic
 * binaries -- same rationale as the other tools' allowlists: a blocklist
 * would silently start trusting whatever else happens to be on a target
 * box's PATH. Nothing here can write, delete, restart a service, or open a
 * shell; that keeps this tool a read-only diagnostic aid even though (unlike
 * kubectl-readonly's RBAC-backed ServiceAccount) there is no cluster-level
 * backstop enforcing that if this allowlist were ever bypassed.
 */

export class BlockedTargetError extends Error {}
export class BlockedCommandError extends Error {}

/** Remote binaries this tool will ever invoke. Read-only diagnostics only --
 * nothing here writes, deletes, restarts a service, or opens an interactive
 * shell. */
const ALLOWED_COMMANDS = new Set([
  "uptime",
  "uname",
  "hostname",
  "whoami",
  "id",
  "date",
  "df",
  "du",
  "free",
  "ps",
  "top",
  "who",
  "w",
  "ss",
  "netstat",
  "ip",
  "systemctl",
  "journalctl",
  "docker",
  "cat",
  "head",
  "tail",
  "ls",
  "grep",
  "find",
]);

/** systemctl/docker subcommands that are read-only; every other subcommand
 * for these two is rejected even though the binary itself is allowed. */
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  systemctl: new Set(["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show"]),
  docker: new Set(["ps", "logs", "inspect", "images", "stats", "top", "version", "info"]),
};

/**
 * Every token (after the command itself) must match this charset: no shell
 * metacharacters, no quotes, no whitespace-adjacent escapes -- nothing that
 * could change meaning once it reaches the remote login shell. Paths,
 * flags, unit names, container names/ids, and numeric values all fit.
 */
const SAFE_TOKEN = /^[A-Za-z0-9._\-/:=@,]+$/;

/** Splits a command line into tokens on whitespace, honoring single/double-quoted
 * spans (no shell involved -- this only groups a caller's "quoted phrase"). */
export function tokenize(commandLine: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(commandLine)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

export interface Target {
  user: string;
  host: string;
  port: number;
}

/**
 * Validates a caller-supplied target string ("host", "user@host", or
 * "user@host:port") against the operator-configured allowlist and returns
 * the exact user/host/port to dial. The allowlist entries themselves (not
 * the caller's string) are the source of truth for user/port when the
 * caller only supplies a bare host.
 */
export function validateTarget(rawTarget: string, allowedHosts: Target[]): Target {
  const parsed = parseTarget(rawTarget);
  if (!parsed) {
    throw new BlockedTargetError(`"${rawTarget}" is not a valid target (expected "host" or "user@host").`);
  }
  const match = allowedHosts.find(
    (entry) =>
      entry.host === parsed.host.toLowerCase() &&
      (parsed.user === undefined || entry.user === parsed.user.toLowerCase()) &&
      (parsed.port === undefined || entry.port === parsed.port),
  );
  if (!match) {
    throw new BlockedTargetError(
      `Target "${rawTarget}" is not in the configured allowlist. Allowed hosts: ${allowedHosts
        .map((h) => `${h.user}@${h.host}:${h.port}`)
        .join(", ")}.`,
    );
  }
  return match;
}

function parseTarget(raw: string): { user?: string; host: string; port?: number } | undefined {
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
 * Validates a tokenized remote command and returns the exact argv to hand to
 * ssh (unmodified beyond the allowlist/charset check). Throws
 * {@link BlockedCommandError} on anything outside the allowlist.
 */
export function validateCommand(tokens: string[]): string[] {
  const [command, ...rest] = tokens;
  if (!command) {
    throw new BlockedCommandError("No remote command given.");
  }
  if (!ALLOWED_COMMANDS.has(command)) {
    throw new BlockedCommandError(
      `Command "${command}" is not allowed. Allowed commands: ${[...ALLOWED_COMMANDS].join(", ")}.`,
    );
  }

  const readonlySubcommands = READONLY_SUBCOMMANDS[command];
  if (readonlySubcommands) {
    const subcommand = rest[0];
    if (!subcommand || !readonlySubcommands.has(subcommand)) {
      const attempted = `${command} ${subcommand ?? ""}`.trim();
      throw new BlockedCommandError(
        `"${attempted}" is not allowed. Allowed "${command}" subcommands: ${[...readonlySubcommands].join(", ")}.`,
      );
    }
  }

  for (const token of rest) {
    if (!SAFE_TOKEN.test(token)) {
      throw new BlockedCommandError(
        `Argument "${token}" contains characters that are not allowed (letters, digits, and . _ - / : = @ , only).`,
      );
    }
  }

  return tokens;
}
