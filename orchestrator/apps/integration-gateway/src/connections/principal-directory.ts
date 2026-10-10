import { SecretRecordStore, type SecretApiLike } from "../credential-store/secret-record-store.js";

/**
 * Maps a verified email to the chat subject (`openwebui:<id>`) whose
 * credentials the Connections page manages (docs/adr/0046).
 *
 * Needed because the page and the chat know the same human by different
 * names: the page signs in against the IdP and learns an email, while every
 * stored credential is keyed by Open WebUI's internal user id. Open WebUI
 * forwards both in the signed per-request JWT, so agent-orchestrator records
 * the pair here each time it verifies one (`PUT /connections/api/principals`).
 *
 * The mapping is deliberately the only thing written -- no credential is ever
 * re-keyed onto the email. Re-keying is what produced the PR #144 triage
 * re-authorization loop; a lookup table cannot.
 *
 * Latest write wins. Open WebUI enforces one account per email, so two live
 * subjects cannot both claim one; a newer subject for an email means the old
 * account was deleted and recreated, and following it is the right answer.
 */
export interface PrincipalDirectory {
  record(email: string, subject: string): Promise<void>;
  lookup(email: string): Promise<string | undefined>;
}

export class K8sSecretPrincipalDirectory implements PrincipalDirectory {
  private readonly store: SecretRecordStore;

  constructor(opts: { namespace: string; api: SecretApiLike }) {
    this.store = new SecretRecordStore({
      namespace: opts.namespace,
      namePrefix: "connections-principal",
      keyLabel: "controller-agent.io/email",
      commonLabels: { "controller-agent.io/credential": "connections-principal" },
      api: opts.api,
    });
  }

  async record(email: string, subject: string): Promise<void> {
    const key = normalizeEmail(email);
    // Skips the write when nothing changed -- the orchestrator calls this once
    // per user per process, but a fleet restart would otherwise rewrite every
    // record at once.
    const existing = await this.store.get(key);
    if (existing?.subject === subject) return;
    await this.store.put(key, { subject, updatedAt: new Date().toISOString() });
  }

  async lookup(email: string): Promise<string | undefined> {
    return (await this.store.get(normalizeEmail(email)))?.subject;
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
