/**
 * Defense-in-depth validation of a caller-supplied `gh` CLI command line, on
 * top of the real authorization boundary: this tool authenticates as the
 * CALLING user's own delegated GitHub token (via integration-gateway's
 * identity-link OAuth Device Flow broker, ADR 0022/0027) rather than a
 * shared bot/ServiceAccount credential -- so the blast radius of anything
 * this allowlist lets through is already bounded by that person's own
 * GitHub permissions on whatever repo they target, exactly like
 * opencode-swe-agent (docs/security.md's "opencode-swe-agent: a
 * deliberately privileged agent" section). This is why, unlike
 * tools/kubectl-readonly's allowlist (whose fixed cluster ServiceAccount
 * grants the same broad read access regardless of who is asking), this
 * allowlist does not additionally restrict flags/values -- only which
 * top-level `gh` command + subcommand may run at all.
 *
 * Top-level commands are an explicit ALLOWLIST, not "everything except
 * auth/config" -- same rationale as kubectl-readonly's resource-kind
 * allowlist: a blocklist would silently start exposing whatever new
 * subcommand a future `gh` release adds. Commands deliberately excluded
 * entirely (not just individual subcommands): `auth` (would let a caller
 * overwrite this container's token/host configuration), `api` (arbitrary
 * REST/GraphQL calls, including mutating ones, with no per-endpoint
 * validation -- a genuine escape hatch this tool does not offer in v1),
 * `config`/`alias`/`extension`/`completion` (local CLI configuration, not a
 * GitHub operation), `secret`/`variable`/`ssh-key`/`gpg-key`/`codespace`
 * (credential/infra management, out of scope for "run a GitHub operation"),
 * and `browse` (opens a browser -- meaningless in a headless container).
 *
 * Within each allowed top-level command, individual subcommands that are
 * either irreversible-ish or orthogonal to this tool's purpose are excluded
 * too, e.g. `issue transfer`/`repo delete`/`workflow run`/`release delete`.
 * See the per-command comments below for the reasoning on each exclusion.
 */

export class BlockedCommandError extends Error {}

/** Top-level `gh` command -> allowed subcommands. Both must match for a command line to pass. */
const ALLOWED_COMMANDS: Record<string, Set<string>> = {
  // No `delete`/`transfer`/`lock`/`pin`: deleting or transferring an issue is
  // effectively irreversible/out-of-repo, locking/pinning is a moderation
  // action orthogonal to this tool's "read and act on issues" purpose.
  issue: new Set(["view", "list", "create", "comment", "edit", "close", "reopen"]),
  // `merge`/`review` are core, expected actions for a GitHub-operations tool
  // acting as an authorized human -- the same posture opencode-swe-agent
  // already takes (ADR 0013/0022), not an escalation introduced here.
  pr: new Set(["view", "list", "create", "comment", "edit", "close", "reopen", "diff", "checks", "merge", "review", "status"]),
  // No `delete`/`archive`/`edit`/`rename`: those mutate repo-level settings
  // (visibility, default branch, name) rather than act on its content --
  // out of scope for this tool; use the GitHub UI/API directly for that.
  repo: new Set(["view", "list", "clone"]),
  // No `create`/`upload`/`delete`/`delete-asset`/`edit`: release asset
  // management is a distinct, higher-blast-radius concern (can rewrite
  // published artifacts) left out of v1.
  release: new Set(["view", "list"]),
  // No `delete`: irreversible.
  gist: new Set(["view", "list", "create"]),
  // No `delete`/`edit`/`clone`: label deletion/rename can silently detach
  // history from issues/PRs that referenced it.
  label: new Set(["list", "create"]),
  // Always read-only by nature -- no subcommand restrictions needed beyond
  // "must be one of gh's actual search targets".
  search: new Set(["issues", "prs", "repos", "code", "commits"]),
  // No `run`/`enable`/`disable`: triggering arbitrary CI or toggling a
  // workflow's enabled state is a distinct, higher-blast-radius capability
  // (arbitrary code execution in Actions, cost) left out of v1.
  workflow: new Set(["view", "list"]),
  // No `cancel`/`delete`/`rerun`: avoid interfering with in-flight or
  // historical CI runs; `download` is allowed (read-only artifact fetch).
  run: new Set(["view", "list", "watch", "download"]),
} as const;

/** Splits a command line into tokens, honoring single/double-quoted spans (no shell involved). */
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
 * Validates a tokenized `gh` command line and returns the exact argv to
 * spawn (unmodified beyond the allowlist check itself -- see the file
 * header for why flags/values aren't additionally restricted here). Throws
 * {@link BlockedCommandError} on anything outside the allowlist.
 */
export function validateCommand(tokens: string[]): string[] {
  const [command, subcommand] = tokens;
  if (!command) {
    throw new BlockedCommandError("No gh command given.");
  }
  const allowedSubcommands = ALLOWED_COMMANDS[command];
  if (!allowedSubcommands) {
    throw new BlockedCommandError(
      `Command "gh ${command}" is not allowed. Allowed commands: ${Object.keys(ALLOWED_COMMANDS).join(", ")}.`,
    );
  }
  if (!subcommand || !allowedSubcommands.has(subcommand)) {
    const attempted = `gh ${command} ${subcommand ?? ""}`.trim();
    throw new BlockedCommandError(
      `"${attempted}" is not allowed. Allowed "gh ${command}" subcommands: ${[...allowedSubcommands].join(", ")}.`,
    );
  }
  return tokens;
}
