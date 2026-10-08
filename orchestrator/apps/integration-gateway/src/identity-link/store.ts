import { decodeEncryptionKey } from "../credential-store/field-encryption.js";

/**
 * Re-exported so the many callers that import it from here keep working. The
 * implementation moved to `../credential-store/field-encryption.ts` when the
 * store moved off Redis (docs/adr/0034) -- it is shared with `claude-auth/`,
 * which was already re-exporting it from this module.
 */
export { decodeEncryptionKey };

/** A linked external-identity credential for one `(provider, subject)` pair. */
export interface LinkedCredential {
  githubLogin: string;
  token: string;
  expiresAt: string;
  refreshToken: string | undefined;
  refreshExpiresAt: string | undefined;

  /**
   * The provider's own id for this account, for providers that are not GitHub
   * (an Atlassian account id, say).
   *
   * Added ALONGSIDE `githubLogin` rather than replacing it, deliberately.
   * Claude credentials are keyed on a canonical `github:<login>` subject
   * (docs/adr/0029), and re-keying that path is what produced the triage
   * re-authorization loop in PR #144 — reverted by #145. So this field records
   * a non-GitHub identity without touching how anything is keyed: the subject a
   * credential is stored under is still whatever the caller already resolved
   * to, and nothing reads this field to decide where to look.
   */
  accountId?: string;
}

/**
 * Durable, subject-keyed store for linked external-identity credentials.
 *
 * "Durable" is the whole contract, and it was not being met: the only
 * implementation was Redis-backed, that Redis runs with persistence disabled on
 * an emptyDir, and a restart deleted every link in the cluster. See
 * `../credential-store/secret-record-store.ts` and docs/adr/0034. The interface
 * itself needed no change -- {@link K8sSecretIdentityLinkStore} implements it
 * unaltered.
 */
export interface IdentityLinkStore {
  get(provider: string, subject: string): Promise<LinkedCredential | undefined>;
  set(provider: string, subject: string, cred: LinkedCredential): Promise<void>;
  /**
   * Resolves as soon as a credential lands for (provider, subject) -- or
   * `undefined` once `timeoutMs` elapses. Lets a caller (agent-orchestrator,
   * across the HTTP `/wait` route) hold a connection open across the OAuth
   * browser round-trip instead of re-checking on every chat turn.
   */
  waitForCompletion(provider: string, subject: string, timeoutMs: number): Promise<LinkedCredential | undefined>;
}
