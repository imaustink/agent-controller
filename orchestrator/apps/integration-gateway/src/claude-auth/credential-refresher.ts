import type { ClaudeTokenStore } from "./store.js";

/**
 * Refreshing a stored `login` (Remote Control) credential here, in the gateway,
 * rather than leaving it to whatever run happens to pick it up next.
 *
 * Why this has to exist at all. Anthropic ROTATES the refresh token on every
 * refresh, and until now the only thing that ever refreshed was a run's own
 * in-pod CLI. That gave the stored credential two ways to die, and the store
 * was a passive bystander for both:
 *
 *   1. a refresh the pod failed to report back killed the stored copy (its
 *      refresh token had been spent) -- narrowed by the continuous write-back
 *      in claude-code-swe-agent's `credentialsWriteback.ts`, but still only
 *      narrowed, because two concurrent runs for one subject can each refresh
 *      from the same stored token and invalidate the other;
 *   2. nothing refreshed it between runs, so a link nobody exercised aged out
 *      on its own. The CLI itself knows this failure has a name --
 *      `refresh_token_expired` and `refresh_token_expires_in` are both strings
 *      in the shipped binary -- so a refresh token is NOT indefinitely valid
 *      and an idle link is a link on a timer.
 *
 * Doing it here fixes both, because the gateway is the one place that is
 * single, durable, and able to serialize per subject.
 *
 * ONE INVARIANT DOMINATES THIS FILE: the instant Anthropic returns new tokens,
 * the old refresh token is dead. From that moment the new blob is the only
 * living copy of the credential, so it must be persisted (or, failing that,
 * still handed to the caller and complained about loudly) rather than dropped.
 * Every error path below is written so that a refresh we did not complete
 * leaves the stored credential exactly as it was.
 */

/** Claude Code's OAuth token endpoint. Confirmed present in the shipped CLI binary (v2.1.220). */
export const CLAUDE_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";

/**
 * Claude Code's public OAuth client id. Taken from the authorize URL this
 * gateway itself hands users (see the `client_id` in the link it posts), so it
 * is observed rather than assumed.
 */
export const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

/** Refresh when the access token expires within this long. */
export const DEFAULT_REFRESH_MARGIN_MS = 30 * 60_000;

/**
 * The refresh outcome, kept coarse on purpose -- callers only ever need to know
 * "is there a newer blob to use" and "did the credential just become
 * unrecoverable".
 */
export type RefreshStatus =
  | "refreshed"
  /** Still comfortably valid; nothing was sent. */
  | "not-needed"
  /** No refresh token in the blob, or the blob is not a credentials file. */
  | "unrefreshable"
  /** The service rejected the refresh token itself -- the link is dead and needs a human. */
  | "rejected"
  /** Network/5xx/unparseable -- the stored credential is untouched and retrying later is right. */
  | "transient";

export interface RefreshOutcome {
  status: RefreshStatus;
  /** Present only on `"refreshed"`: the new blob, which is now the ONLY live copy. */
  credentialsJson?: string;
  /** Present only on `"refreshed"`: the new expiry, for logging. */
  expiresAt?: string;
  detail?: string;
}

interface OauthFields {
  refreshToken?: string;
  expiresAt?: number;
}

/** The credentials file nests everything under `claudeAiOauth`; tolerate a flat blob too. */
function readOauth(blob: string): { root: Record<string, unknown>; inner: Record<string, unknown> } | null {
  try {
    const root = JSON.parse(blob) as Record<string, unknown>;
    if (typeof root !== "object" || root === null) return null;
    const nested = root.claudeAiOauth;
    const inner = typeof nested === "object" && nested !== null ? (nested as Record<string, unknown>) : root;
    return { root, inner };
  } catch {
    return null;
  }
}

function fields(inner: Record<string, unknown>): OauthFields {
  const rawExpiry = inner.expiresAt;
  const expiresAt =
    typeof rawExpiry === "number" ? rawExpiry : typeof rawExpiry === "string" ? Number(rawExpiry) : Number.NaN;
  return {
    refreshToken: typeof inner.refreshToken === "string" && inner.refreshToken ? inner.refreshToken : undefined,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
  };
}

/** The blob's access-token expiry as an ISO string, or null. Never returns token material. */
export function credentialExpiresAt(blob: string): string | null {
  const parsed = readOauth(blob);
  if (!parsed) return null;
  const { expiresAt } = fields(parsed.inner);
  return expiresAt === undefined ? null : new Date(expiresAt).toISOString();
}

/**
 * True when the access token is inside `marginMs` of expiry (or already past
 * it). A blob with no readable expiry is treated as due: an unknown expiry is
 * far more likely to be an expired credential than a healthy one, and a
 * needless refresh costs one round trip while a skipped one costs a re-link.
 */
export function needsRefresh(blob: string, marginMs = DEFAULT_REFRESH_MARGIN_MS, now = Date.now()): boolean {
  const parsed = readOauth(blob);
  if (!parsed) return false; // not a credentials file at all -- nothing to do
  const { expiresAt } = fields(parsed.inner);
  if (expiresAt === undefined) return true;
  return expiresAt - now <= marginMs;
}

/**
 * Rebuilds the credentials blob with the new tokens, PRESERVING every other
 * field. The file carries things this code has no business understanding
 * (subscription type, scopes, account hints); dropping them would hand runs a
 * blob subtly unlike the one `claude auth login` produces.
 */
function mergeRefreshed(
  blob: string,
  next: { accessToken: string; refreshToken: string; expiresAt: number; scopes?: string[] },
): string {
  const parsed = readOauth(blob);
  const inner = parsed ? { ...parsed.inner } : {};
  inner.accessToken = next.accessToken;
  inner.refreshToken = next.refreshToken;
  inner.expiresAt = next.expiresAt;
  if (next.scopes && next.scopes.length > 0) inner.scopes = next.scopes;
  // Keep the nesting the file actually had.
  if (parsed && parsed.root.claudeAiOauth !== undefined) {
    return JSON.stringify({ ...parsed.root, claudeAiOauth: inner });
  }
  return JSON.stringify(inner);
}

export interface RefreshDeps {
  fetchImpl?: typeof fetch;
  tokenUrl?: string;
  clientId?: string;
  marginMs?: number;
  now?: () => number;
}

/**
 * Exchanges the blob's refresh token for a new pair.
 *
 * The request is the standard OAuth refresh grant against the endpoint and
 * client id above. Both of those are observed (binary / our own authorize URL),
 * but the exact body this service expects is NOT something this repo can prove
 * from the outside, so every non-success path is deliberately inert: on
 * anything other than a 2xx carrying a parseable token pair, the caller keeps
 * using the credential it already had and the run behaves exactly as it does
 * today. The only way this can make things worse is if the service accepts a
 * refresh and we then lose the result -- which is why `ClaudeCredentialRefresher`
 * persists before returning and shouts if it cannot.
 */
export async function refreshCredentialsBlob(blob: string, deps: RefreshDeps = {}): Promise<RefreshOutcome> {
  const parsed = readOauth(blob);
  if (!parsed) return { status: "unrefreshable", detail: "not a credentials file" };
  const { refreshToken } = fields(parsed.inner);
  if (!refreshToken) return { status: "unrefreshable", detail: "blob carries no refreshToken" };

  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  let res: Response;
  try {
    res = await fetchImpl(deps.tokenUrl ?? CLAUDE_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: deps.clientId ?? CLAUDE_OAUTH_CLIENT_ID,
      }).toString(),
    });
  } catch (err) {
    return { status: "transient", detail: err instanceof Error ? err.message : String(err) };
  }

  if (!res.ok) {
    let body = "";
    try {
      body = (await res.text()).slice(0, 300);
    } catch {
      /* body is a nicety here, not a requirement */
    }
    // `invalid_grant` is the service saying the refresh token is spent or
    // expired -- the one case where trying again later cannot help, and the
    // case a human has to resolve by re-linking.
    const rejected = res.status === 400 && /invalid_grant|refresh_token_expired/i.test(body);
    return { status: rejected ? "rejected" : "transient", detail: `HTTP ${res.status}${body ? `: ${body}` : ""}` };
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    return { status: "transient", detail: `unparseable response: ${err instanceof Error ? err.message : String(err)}` };
  }

  const accessToken = typeof payload.access_token === "string" ? payload.access_token : "";
  // A rotating server returns a new refresh token; a non-rotating one omits it
  // and the old one stays valid. Carry the old one forward in that case rather
  // than writing `undefined` into the file.
  const nextRefresh = typeof payload.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : refreshToken;
  const expiresIn = typeof payload.expires_in === "number" ? payload.expires_in : Number(payload.expires_in);
  if (!accessToken || !Number.isFinite(expiresIn)) {
    return { status: "transient", detail: "response carried no usable access_token/expires_in" };
  }

  const expiresAt = now() + Math.floor(expiresIn) * 1000;
  const scopes =
    typeof payload.scope === "string" && payload.scope.trim() ? payload.scope.trim().split(/\s+/) : undefined;
  return {
    status: "refreshed",
    credentialsJson: mergeRefreshed(blob, { accessToken, refreshToken: nextRefresh, expiresAt, scopes }),
    expiresAt: new Date(expiresAt).toISOString(),
  };
}

export interface ClaudeCredentialRefresherDeps extends RefreshDeps {
  store: Pick<ClaudeTokenStore, "get" | "set">;
  log?: (message: string) => void;
  /** Set false to leave stored credentials strictly alone (an operational off switch). */
  enabled?: boolean;
}

/**
 * Keeps one subject's stored `login` credential fresh, serialized per subject.
 *
 * The serialization is the point, not an optimization: two callers refreshing
 * the same credential concurrently would each spend the same refresh token, and
 * whichever landed second would invalidate the first -- reproducing, inside the
 * gateway, exactly the rotation race that made runs fragile. Sharing one
 * in-flight promise per subject makes concurrent launches cost one refresh.
 */
export class ClaudeCredentialRefresher {
  private readonly inFlight = new Map<string, Promise<string | undefined>>();
  private readonly log: (message: string) => void;

  constructor(private readonly deps: ClaudeCredentialRefresherDeps) {
    this.log = deps.log ?? ((m) => console.log(m));
  }

  /**
   * Returns the freshest `login` blob for `subject`, refreshing and persisting
   * first when it is at or near expiry. Never throws and never returns
   * undefined for a credential that exists -- a failed refresh yields the blob
   * that was already stored, so the caller is never worse off than before.
   */
  async ensureFresh(subject: string): Promise<string | undefined> {
    const existing = await this.deps.store.get(subject, "login");
    const blob = existing?.credentialsJson;
    if (!blob) return undefined;
    if (this.deps.enabled === false) return blob;
    if (!needsRefresh(blob, this.deps.marginMs ?? DEFAULT_REFRESH_MARGIN_MS, (this.deps.now ?? Date.now)())) {
      return blob;
    }

    const pending = this.inFlight.get(subject);
    if (pending) return pending;

    const attempt = this.refreshAndStore(subject, blob).finally(() => this.inFlight.delete(subject));
    this.inFlight.set(subject, attempt);
    return attempt;
  }

  private async refreshAndStore(subject: string, blob: string): Promise<string | undefined> {
    const outcome = await refreshCredentialsBlob(blob, this.deps);

    if (outcome.status !== "refreshed" || !outcome.credentialsJson) {
      // Nothing was rotated, so the stored credential is still whatever it was.
      // `rejected` is worth saying out loud (a human will have to re-link) but
      // deleting the record is deliberately NOT done here: the orchestrator's
      // existing re-auth path owns invalidation, and a refresh endpoint hiccup
      // that merely looked like a rejection must not cost a working link.
      this.log(
        `[claude-refresh] ${outcome.status} for ${subject}${outcome.detail ? `: ${outcome.detail}` : ""}; serving the stored credential unchanged`,
      );
      return blob;
    }

    // From here the OLD refresh token is dead and this blob is the only living
    // copy of the credential. Persisting it is not bookkeeping, it is the
    // difference between a durable link and a re-link prompt.
    try {
      await this.deps.store.set(subject, {
        kind: "login",
        credentialsJson: outcome.credentialsJson,
        createdAt: new Date((this.deps.now ?? Date.now)()).toISOString(),
      });
      const readBack = await this.deps.store.get(subject, "login");
      if (readBack?.credentialsJson !== outcome.credentialsJson) {
        // `set` swallows its own storage errors by design, so a silent drop
        // would otherwise be indistinguishable from success -- and it is the
        // one outcome that destroys the link.
        this.log(
          `[claude-refresh] STORED-BUT-UNVERIFIED for ${subject}: the refreshed credential did not read back. ` +
            `The previous refresh token is already spent, so the stored credential is now stale and this link will need re-linking.`,
        );
        return outcome.credentialsJson;
      }
    } catch (err) {
      this.log(
        `[claude-refresh] FAILED TO PERSIST refreshed credential for ${subject} (${err instanceof Error ? err.message : String(err)}). ` +
          `The previous refresh token is already spent, so this link will need re-linking.`,
      );
      // Still hand back the live blob: this caller can at least succeed, and
      // the run's own write-back may yet persist it.
      return outcome.credentialsJson;
    }

    this.log(`[claude-refresh] refreshed ${subject}'s Remote Control credential (expires ${outcome.expiresAt})`);
    return outcome.credentialsJson;
  }
}

/** How often the background sweep runs. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * How close to expiry a credential must be for the SWEEP to renew it.
 *
 * Wider than the on-read margin on purpose. The sweep's job is that a link is
 * never found dead, so it should act well before anything needs the credential;
 * the read path's job is only that the blob it is about to hand out is usable.
 */
export const DEFAULT_SWEEP_MARGIN_MS = 4 * 60 * 60_000;

export interface CredentialSweeperDeps {
  store: Pick<ClaudeTokenStore, "get" | "listSubjects">;
  /** Refreshes one subject -- the same serialized path the read path uses. */
  refresher: Pick<ClaudeCredentialRefresher, "ensureFresh">;
  intervalMs?: number;
  marginMs?: number;
  log?: (message: string) => void;
  now?: () => number;
}

/**
 * Renews stored Remote Control credentials on a timer, independently of whether
 * anything is using them.
 *
 * Refresh-on-read cannot cover this: it only fires when something reads, so a
 * link nobody exercises is a link nothing renews. And a refresh token is not
 * valid forever -- the CLI ships `refresh_token_expired` and
 * `refresh_token_expires_in` as strings, so an idle link is on a timer whether
 * or not we act. Left alone, a user who links today and triggers nothing for
 * long enough is asked to link again for no reason they can see.
 *
 * Runs in the gateway because that is the only long-lived, single-instance
 * component that holds the store. Reuses `ClaudeCredentialRefresher.ensureFresh`
 * rather than refreshing directly, so the sweep and a concurrent launch share
 * one in-flight refresh per subject instead of rotating each other's token out.
 */
export class ClaudeCredentialSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: CredentialSweeperDeps) {
    this.log = deps.log ?? ((m) => console.log(m));
  }

  start(): void {
    if (this.timer) return;
    if (!this.deps.store.listSubjects) {
      // Standing down is stated, not silent: a sweeper that quietly did nothing
      // would look exactly like a working one right up until someone's link
      // expired.
      this.log("[claude-refresh] sweep disabled: this credential store cannot enumerate subjects");
      return;
    }
    const intervalMs = this.deps.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.timer = setInterval(() => void this.sweep(), intervalMs);
    this.timer.unref?.();
    // Sweep once at startup too, so a gateway that restarts often still renews
    // (and so a deployment does not wait a full interval to find out the sweep
    // is broken).
    void this.sweep();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass. Refreshes every `login` credential inside the sweep margin,
   * sequentially -- there is no hurry here, and a burst of parallel token
   * requests on a schedule is a worse neighbour than a slow loop.
   */
  async sweep(): Promise<{ examined: number; refreshed: number; failed: number }> {
    if (this.running) return { examined: 0, refreshed: 0, failed: 0 };
    this.running = true;
    const marginMs = this.deps.marginMs ?? DEFAULT_SWEEP_MARGIN_MS;
    const now = this.deps.now ?? Date.now;
    let examined = 0;
    let refreshed = 0;
    let failed = 0;
    try {
      let subjects: string[];
      try {
        subjects = (await this.deps.store.listSubjects?.("login")) ?? [];
      } catch (err) {
        // Deliberately loud: a list that failed is not an empty store, and
        // treating it as one is how a sweep does nothing forever.
        this.log(
          `[claude-refresh] sweep could not list stored credentials: ${err instanceof Error ? err.message : String(err)}`,
        );
        return { examined: 0, refreshed: 0, failed: 1 };
      }

      for (const subject of subjects) {
        examined += 1;
        const record = await this.deps.store.get(subject, "login");
        const blob = record?.credentialsJson;
        if (!blob || !needsRefresh(blob, marginMs, now())) continue;
        const before = credentialExpiresAt(blob);
        const after = credentialExpiresAt((await this.deps.refresher.ensureFresh(subject)) ?? blob);
        // `ensureFresh` never throws and reports its own failures; compare
        // expiries to know whether this pass actually renewed anything.
        if (after && after !== before) refreshed += 1;
        else failed += 1;
      }
      if (refreshed > 0 || failed > 0) {
        this.log(`[claude-refresh] sweep: ${examined} examined, ${refreshed} refreshed, ${failed} still due`);
      }
      return { examined, refreshed, failed };
    } finally {
      this.running = false;
    }
  }
}
