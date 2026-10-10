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

/**
 * Reads just the expiry out of a credentials blob, for logging. Never returns
 * or logs token material -- the point is to make "was this credential already
 * dead when we injected it?" answerable from a log line, which is the question
 * that has repeatedly been unanswerable because the agent pod (and its logs)
 * are gone by the time anyone looks.
 */
export function credentialExpiry(blob: string): string | null {
  try {
    const parsed = JSON.parse(blob) as Record<string, unknown>;
    const inner = (parsed.claudeAiOauth ?? parsed) as Record<string, unknown>;
    const raw = inner.expiresAt;
    const ms = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

/** Outcomes where trying again could plausibly succeed. */
function isRetryable(outcome: CredentialsWritebackOutcome): boolean {
  // `failed` is the gateway being unreachable or erroring -- the case worth
  // retrying, and the case that loses credentials today. `malformed` is a read
  // that raced the CLI's in-place rewrite, so a re-read is likely to be clean.
  return outcome === "failed" || outcome === "malformed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

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

/** Default cadence for re-checking the credentials file during a turn. */
const DEFAULT_WATCH_INTERVAL_MS = 5_000;
/** Attempts for the final flush, which has no next tick to retry on. */
const DEFAULT_FLUSH_ATTEMPTS = 4;
/** Delay between those attempts -- long enough to outlast a gateway rollout's gap. */
const DEFAULT_FLUSH_RETRY_DELAY_MS = 3_000;

export interface CredentialsWritebackWatcher {
  /** Starts polling. Cheap no-op when write-back is disabled. */
  start(): void;
  /**
   * Stops polling and makes a final, retried attempt to persist anything the
   * CLI wrote since the last successful store. Safe to call more than once.
   */
  stop(): Promise<CredentialsWritebackOutcome>;
}

export interface CredentialsWritebackWatcherOptions extends CredentialsWritebackOptions {
  /** Poll cadence; injectable for tests. */
  intervalMs?: number;
  /** Attempts for the final flush; injectable for tests. */
  flushAttempts?: number;
  /** Delay between final-flush attempts; injectable for tests. */
  flushRetryDelayMs?: number;
  /** Injectable clock/logger seam for tests. */
  log?: (message: string) => void;
}

/**
 * Persists the run's credentials file CONTINUOUSLY, not once at the end.
 *
 * Why this is not just a nicety: Anthropic ROTATES the refresh token on every
 * refresh, so the moment a run's CLI refreshes, the copy in the store is dead.
 * A single missed write-back therefore does not degrade the link, it KILLS it
 * -- the stored refresh token has been spent and only a human re-link can
 * recover. A write-back that ran once, at the end of the turn, staked the whole
 * link on that one POST landing:
 *
 *   - a pod killed, evicted, or hitting `activeDeadlineSeconds` mid-turn never
 *     reached it at all;
 *   - it had no retry, and `release.yml` deploys on every push to `main`, so a
 *     POST arriving during a gateway rollout (ADR 0033 recorded eleven in
 *     fourteen hours) simply lost the refresh.
 *
 * Polling shrinks the exposure window from "the whole turn" to `intervalMs`,
 * and makes the loop its own retry: a tick that fails to store does not advance
 * `lastPersisted`, so the next tick tries the same blob again. The final
 * `stop()` flush covers a refresh that lands in the last few seconds, where
 * there is no next tick.
 */
export function createCredentialsWritebackWatcher(
  opts: CredentialsWritebackWatcherOptions,
): CredentialsWritebackWatcher {
  const log = opts.log ?? ((m: string) => console.error(m));
  const enabled = Boolean(opts.url && opts.token);
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCH_INTERVAL_MS;

  // Advances only on a CONFIRMED store, so any failure is retried rather than
  // being mistaken for "already persisted".
  let lastPersisted = opts.seeded;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight = false;
  let stopped = false;

  const attemptOnce = async (): Promise<CredentialsWritebackOutcome> => {
    const outcome = await persistRefreshedCredentials({ ...opts, seeded: lastPersisted });
    if (outcome === "stored") {
      // Re-read rather than trusting the file to have held still: `seeded` for
      // the next comparison must be exactly what we just stored, and
      // `persistRefreshedCredentials` is what read it.
      try {
        lastPersisted = await readFile(join(opts.homeDir, ".claude", ".credentials.json"), "utf8");
      } catch {
        // Unreadable now; the next tick's compare against the old value will
        // simply try again, which is the safe direction.
      }
      log(
        `[claude-code-swe-agent] credential write-back: stored a refreshed credential (expires ${credentialExpiry(lastPersisted) ?? "unknown"})`,
      );
    } else if (isRetryable(outcome)) {
      log(`[claude-code-swe-agent] credential write-back: ${outcome} -- will retry`);
    }
    return outcome;
  };

  const tick = async (): Promise<void> => {
    // A slow POST must not have a second one stacked behind it; the next tick
    // will pick up whatever this one leaves unpersisted.
    if (inFlight || stopped) return;
    inFlight = true;
    try {
      await attemptOnce();
    } finally {
      inFlight = false;
    }
  };

  return {
    start(): void {
      if (!enabled || timer) return;
      timer = setInterval(() => void tick(), intervalMs);
      // Never let the watcher hold the process open past the turn.
      timer.unref?.();
    },
    async stop(): Promise<CredentialsWritebackOutcome> {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (!enabled) return "disabled";
      stopped = true;
      // Let an in-flight tick settle so it cannot race the final flush and
      // store a blob older than the one it already sent.
      while (inFlight) await sleep(10);
      stopped = false;

      const attempts = opts.flushAttempts ?? DEFAULT_FLUSH_ATTEMPTS;
      const delayMs = opts.flushRetryDelayMs ?? DEFAULT_FLUSH_RETRY_DELAY_MS;
      let outcome: CredentialsWritebackOutcome = "unchanged";
      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        outcome = await attemptOnce();
        if (!isRetryable(outcome)) return outcome;
        if (attempt < attempts) await sleep(delayMs);
      }
      // Out of attempts on a retryable failure. Say so loudly: the stored
      // credential is now dead (its refresh token was spent in-pod) and the
      // next run will ask the human to re-link.
      log(
        `[claude-code-swe-agent] credential write-back GAVE UP after ${attempts} attempts (${outcome}); ` +
          `the stored credential's refresh token was rotated in this pod, so the link is now stale and will need re-linking`,
      );
      return outcome;
    },
  };
}
