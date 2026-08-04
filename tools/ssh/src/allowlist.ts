/**
 * Defense-in-depth validation of a caller-supplied remote command, on top of
 * the real authorization boundary: target resolution/restriction (see
 * target.ts) and whatever `authorized_keys`/sudoers restrictions exist on
 * the target boxes themselves, which this tool has no visibility into and
 * cannot assume.
 *
 * This matters more here than in tools/kubectl-readonly or tools/github:
 * `spawn("ssh", [..., "user@host", ...remoteArgv])` never runs a local
 * shell, but OpenSSH's client concatenates remoteArgv with spaces and hands
 * that single string to the REMOTE side's login shell (`sh -c "<string>"`)
 * unless the target's authorized_keys forces a fixed command. So unlike
 * kubectl/gh (single local process, no shell anywhere), a caller-supplied
 * `;`, `|`, `$(...)`, backtick, or redirection here is a real remote shell
 * injection primitive, not just noise -- every token (including the command
 * name itself) is restricted to a plain-argument charset (see SAFE_TOKEN)
 * UNCONDITIONALLY, regardless of which command-allowlist mode is in effect
 * below. That charset check is what actually prevents a caller from
 * escaping the "one argv, no local shell" model; the command allowlist is a
 * separate, independently configurable restriction on top of it.
 *
 * The command allowlist itself has three modes (see AppConfig.allowedCommands
 * in config.ts, sourced from SSH_ALLOWED_COMMANDS):
 *   - default (unset): DEFAULT_ALLOWED_COMMANDS, a curated read-only
 *     diagnostic set, with systemctl/docker restricted to read-only
 *     subcommands and ip/find restricted to read-only forms (see below).
 *   - a custom Set: only those top-level commands are allowed; the
 *     systemctl/docker/ip/find restrictions below still apply if the
 *     operator includes them.
 *   - "*" (wide open): no command-name or subcommand restriction at all --
 *     an explicit per-deployment opt-in for environments where the operator
 *     accepts write/destructive risk in exchange for not maintaining a
 *     curated list. Still charset-checked, so this is "any command, no
 *     shell injection" rather than "no restriction at all".
 */

export class BlockedCommandError extends Error {}

export type AllowedCommands = ReadonlySet<string> | "*";

/** The default, curated read-only diagnostic set -- used when
 * SSH_ALLOWED_HOSTS's sibling SSH_ALLOWED_COMMANDS is unset. Nothing here
 * writes, deletes, restarts a service, or opens an interactive shell. */
export const DEFAULT_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
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
 * for these two is rejected even though the binary itself is allowed. Only
 * applied when the effective command allowlist isn't "*" (wide open). */
const READONLY_SUBCOMMANDS: Record<string, Set<string>> = {
  systemctl: new Set(["status", "list-units", "list-unit-files", "is-active", "is-enabled", "show"]),
  docker: new Set(["ps", "logs", "inspect", "images", "stats", "top", "version", "info"]),
};

/** `ip` objects this tool ever queries, and the read-only actions allowed on
 * them -- `ip`'s own default action (when none is given) is already "list",
 * so e.g. "ip addr" alone is read-only too. Every mutating action
 * (add/del/set/change/replace/flush/...) is rejected by omission: this is an
 * ALLOWLIST of actions, not a blocklist of dangerous ones. */
const IP_READONLY_OBJECTS = new Set(["addr", "address", "route", "link", "neigh", "neighbour", "rule", "tunnel", "maddr", "mroute", "netns"]);
const IP_READONLY_ACTIONS = new Set(["show", "list", "get"]);

/**
 * `find`'s action primaries -- `-delete`, `-exec[dir]`, `-ok[dir]`, and the
 * `-f{print,printf,ls}` family all write to the filesystem (or run arbitrary
 * commands, in `-exec`'s case), so they're rejected wherever they appear in
 * argv -- `find`'s own grammar allows them anywhere after the starting
 * path(s), not just at a fixed position.
 */
const FIND_DANGEROUS_PRIMARIES = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"]);

function validateIp(rest: string[]): void {
  let i = 0;
  while (i < rest.length && rest[i]?.startsWith("-")) i++; // skip leading global flags, e.g. "-s", "-4", "-br"
  const object = rest[i];
  if (!object || !IP_READONLY_OBJECTS.has(object)) {
    throw new BlockedCommandError(
      `"ip ${rest.join(" ")}" is not allowed. Allowed ip objects: ${[...IP_READONLY_OBJECTS].join(", ")} (read-only actions only).`,
    );
  }
  i++;
  while (i < rest.length && rest[i]?.startsWith("-")) i++; // skip flags between object and action
  const action = rest[i];
  if (action !== undefined && !IP_READONLY_ACTIONS.has(action)) {
    throw new BlockedCommandError(
      `"ip ${object} ${action}" is not allowed. Allowed ip actions: ${[...IP_READONLY_ACTIONS].join(
        ", ",
      )} (or omit the action for ip's own default list behavior).`,
    );
  }
}

function validateFind(rest: string[]): void {
  for (const token of rest) {
    if (FIND_DANGEROUS_PRIMARIES.has(token)) {
      throw new BlockedCommandError(
        `"find ... ${token}" is not allowed -- find is restricted to read-only searches (no -delete/-exec/-execdir/-ok/-okdir/-fprint/-fprintf/-fls).`,
      );
    }
  }
}

/**
 * Every token -- including the command name itself -- must match this
 * charset: no shell metacharacters, no quotes, no whitespace-adjacent
 * escapes -- nothing that could change meaning once it reaches the remote
 * login shell. Paths, flags, unit names, container names/ids, and numeric
 * values all fit. Enforced unconditionally, even in "*" (wide open) mode --
 * see the file header.
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

/**
 * Validates a tokenized remote command and returns the exact argv to hand to
 * ssh (unmodified beyond the allowlist/charset check). Throws
 * {@link BlockedCommandError} on anything outside the allowlist.
 *
 * @param allowedCommands defaults to {@link DEFAULT_ALLOWED_COMMANDS}; pass
 *   `"*"` to skip the command-name/subcommand allowlist entirely (the
 *   charset check below still always applies).
 */
export function validateCommand(tokens: string[], allowedCommands: AllowedCommands = DEFAULT_ALLOWED_COMMANDS): string[] {
  const [command, ...rest] = tokens;
  if (!command) {
    throw new BlockedCommandError("No remote command given.");
  }

  const wideOpen = allowedCommands === "*";

  if (!wideOpen) {
    if (!allowedCommands.has(command)) {
      throw new BlockedCommandError(
        `Command "${command}" is not allowed. Allowed commands: ${[...allowedCommands].join(", ")}.`,
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

    if (command === "ip") validateIp(rest);
    if (command === "find") validateFind(rest);
  }

  for (const token of tokens) {
    if (!SAFE_TOKEN.test(token)) {
      throw new BlockedCommandError(
        `Argument "${token}" contains characters that are not allowed (letters, digits, and . _ - / : = @ , only).`,
      );
    }
  }

  return tokens;
}
