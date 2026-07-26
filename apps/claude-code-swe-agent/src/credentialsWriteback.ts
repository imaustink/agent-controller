import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Persists the `~/.claude/.credentials.json` this run's Claude Code CLI
 * refreshed in-pod back to integration-gateway's credential store.
 *
 * Why this exists: in Remote Control mode the CLI authenticates from a
 * credentials FILE seeded into the run's HOME (an emptyDir) by an init
 * container, from a single copy the gateway stored when the human linked their
 * account. The CLI refreshes that credential when its access token ages out --
 * and the refresh ROTATES the refresh token, invalidating the copy still sitting
 * in the store. The refreshed file then dies with the pod. Net effect before
 * this write-back existed: an account linked hours ago works for exactly as
 * long as its original access token, then every run fails with "Login expired ·
 * Please run /login" and the human is asked to re-link something they already
 * linked. Writing the refreshed file back is what makes a link durable.
 *
 * Deliberately best-effort in every failure mode (missing env, unreadable
 * file, HTTP error): the turn's real work is already done by the time this
 * runs, and losing a refresh is a future inconvenience, while failing a
 * completed turn over it is an immediate one.
 */
export interface CredentialsWritebackOptions {
  /** The run's HOME -- `.claude/.credentials.json` beneath it is what gets read. */
  homeDir: string;
  /** Gateway endpoint that stores the blob (`POST /claude-auth/api/refresh`). Empty/unset disables write-back. */
  url: string;
  /** Per-run grant token authorizing exactly this subject's credential update. Empty/unset disables write-back. */
  token: string;
  /**
   * The blob this run STARTED with (the injected
   * `CLAUDE_LOGIN_CREDENTIALS_JSON`). Used to skip the no-op case: most turns
   * never trigger a refresh, and re-storing a byte-identical blob would only
   * churn the record's `createdAt`.
   */
  seeded: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

export type CredentialsWritebackOutcome =
  | "disabled"
  | "unchanged"
  | "unreadable"
  | "malformed"
  | "stored"
  | "failed";

export async function persistRefreshedCredentials(
  opts: CredentialsWritebackOptions,
): Promise<CredentialsWritebackOutcome> {
  if (!opts.url || !opts.token) return "disabled";

  let current: string;
  try {
    current = await readFile(join(opts.homeDir, ".claude", ".credentials.json"), "utf8");
  } catch {
    // No credentials file at all -- e.g. Remote Control isn't in use for this
    // run, or the init container never seeded one. Nothing to persist.
    return "unreadable";
  }

  if (!current.trim()) return "unreadable";
  if (opts.seeded.trim() && current.trim() === opts.seeded.trim()) return "unchanged";

  try {
    // Guard against storing a truncated/half-written file: the CLI rewrites
    // this file in place, so a read that raced the write would otherwise
    // replace a working stored credential with an unusable one.
    JSON.parse(current);
  } catch {
    return "malformed";
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${opts.token}` },
      body: JSON.stringify({ credentialsJson: current }),
    });
    if (!res.ok) {
      console.error(`[claude-code-swe-agent] credential write-back failed: ${res.status}`);
      return "failed";
    }
    return "stored";
  } catch (err) {
    console.error(
      "[claude-code-swe-agent] credential write-back threw:",
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}
