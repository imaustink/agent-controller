import { decodeEncryptionKey } from "../credential-store/field-encryption.js";

export { decodeEncryptionKey };

/** Which Claude Code credential flow produced a record -- see `ClaudeTokenRecord`'s doc. */
export type ClaudeAuthKind = "setup-token" | "login";

/**
 * A linked Claude Code credential for one subject. Exactly one of `token`
 * (the `claude setup-token` OAuth token) / `credentialsJson` (the full
 * `claude auth login --claudeai` credentials-file contents, needed for
 * Remote Control -- see `pty-login.ts`) is populated, discriminated by
 * `kind`. Both flows are kept in ONE record type (rather than two, or a
 * union) because a subject can hold both independently at once -- they're
 * stored under distinct object-name prefixes (see
 * `K8sSecretClaudeTokenStore`'s `storeFor`) -- and every caller already has to branch on `kind`
 * to know which field to read, so a union would just move that branch to the
 * type system for no benefit.
 */
export interface ClaudeTokenRecord {
  kind: ClaudeAuthKind;
  token?: string;
  credentialsJson?: string;
  createdAt: string;
}

/**
 * Durable, subject-keyed store for per-user Claude Code credentials
 * (docs/adr/0027) -- a sibling to `identity-link/store.ts`'s
 * `IdentityLinkStore`, kept separate rather than generalized into one
 * interface: unlike a GitHub credential (one provider, `expiresAt`/
 * `refreshToken` fields), this only ever has these two shapes and one
 * "provider" -- the PTY flows that produce them are different enough from
 * GitHub's HTTP device flow that sharing an abstraction here would cost more
 * than it saves.
 *
 * `kind` defaults to `"setup-token"` on every method below so existing
 * callers written before the `login` flow existed are unaffected.
 */
export interface ClaudeTokenStore {
  get(subject: string, kind?: ClaudeAuthKind): Promise<ClaudeTokenRecord | undefined>;
  set(subject: string, record: ClaudeTokenRecord): Promise<void>;
  /** Resolves as soon as a record lands for `subject`/`kind`, or `undefined` once `timeoutMs` elapses. */
  waitForCompletion(subject: string, timeoutMs: number, kind?: ClaudeAuthKind): Promise<ClaudeTokenRecord | undefined>;
  /**
   * Removes a subject's stored record for `kind` -- called when
   * agent-orchestrator sees claude-code-swe-agent report an expired/invalid
   * credential mid-run (docs/adr/0027's re-auth path), so the NEXT
   * delegation attempt's `get`/pre-flight check finds nothing linked and
   * starts a fresh flow automatically, rather than repeating the same bad
   * credential forever.
   */
  delete(subject: string, kind?: ClaudeAuthKind): Promise<void>;
  /**
   * Every subject holding a record of `kind` -- for the background refresh
   * sweep (claude-auth/credential-refresher.ts), which has no subject to look
   * up and so cannot use `get`.
   *
   * Optional because it is the only method that enumerates: the Secret-backed
   * store answers it with a label-selector scan, a deliberate exception to that
   * store's own read-path rule, and no in-memory or test double needs it.
   * Absent means "this deployment cannot sweep", which the sweeper reports and
   * then stands down -- never an empty result silently read as "no links".
   */
  listSubjects?(kind?: ClaudeAuthKind): Promise<string[]>;
  /**
   * Moves an existing record from one subject to another, so a credential the
   * human already authorized keeps working under a new key instead of costing
   * them a fresh flow (docs/adr/0031).
   *
   * Exists because agent-orchestrator changed WHICH subject it keys these
   * records by -- from the entry point's own subject to the caller's principal
   * (ADR 0029/0030 §6) -- and a re-key without a move means every existing user
   * re-authorizes for no reason they can perceive. The alternative, leaving the
   * old record in place as a copy, is worse than either: the write-back that
   * keeps a `login` credential alive only ever writes the NEW key, so the copy
   * silently rots and whichever flow still reads it fails with "Login expired".
   *
   * Deliberately non-destructive at the destination: an existing record there
   * is never clobbered (`"occupied"`), because it is by definition at least as
   * current as the one being moved.
   *
   * Authorization is the CALLER's responsibility, and it is not nothing: this
   * moves a credential between identities, so the caller must have established
   * that both subjects are the same human. See the `rekey` route's doc.
   */
  rekey(fromSubject: string, toSubject: string, kind?: ClaudeAuthKind): Promise<"moved" | "not-found" | "occupied">;
  /**
   * Mints a single-purpose, expiring bearer token that authorizes ONE thing:
   * replacing `subject`'s stored `login` record with a refreshed
   * `credentialsJson` (`POST /claude-auth/api/refresh`). Handed to an
   * individual AgentRun so the run's own Claude Code CLI can persist the
   * credentials it refreshed in-pod -- see that route's doc for why that
   * write-back is what keeps a `claude-remote` link from dying the first time
   * the CLI rotates its refresh token.
   *
   * Deliberately NOT the gateway's own `bearerToken`: that one can read and
   * mint credentials for EVERY subject, and a per-run Job pod is the last
   * place it belongs. A grant token is opaque and random (not a signed claim),
   * so it can be looked up, expired, and revoked simply by deleting it -- no key
   * material has to be shared with agent-orchestrator or baked into a run's
   * environment.
   *
   * Returns the backing object's name alongside the token so the caller can
   * hand ownership of the grant to the AgentRun it is minted for: grants are the
   * one record here with a lifetime, Kubernetes has no TTL on Secrets, and
   * agent-orchestrator's launcher already attaches an `ownerReference` to the
   * per-run identity Secret so the controller's existing retention sweep
   * reclaims it (docs/adr/0034). `expiresAt` is still enforced on read -- the
   * reference is what collects the object, not what bounds the grant.
   */
  createWritebackToken(subject: string, ttlSeconds: number): Promise<{ token: string; secretName: string }>;
  /** Resolves a token minted by {@link createWritebackToken} back to its subject, or `undefined` if it's unknown/expired. */
  resolveWritebackToken(token: string): Promise<string | undefined>;
}
