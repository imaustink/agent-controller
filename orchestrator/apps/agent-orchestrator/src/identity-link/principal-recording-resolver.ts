import type { Identity, IdentityResolver } from "../rbac/types.js";

/** How long to wait before retrying a subject whose record failed. */
const RETRY_AFTER_MS = 5 * 60 * 1000;

/**
 * Wraps the Open WebUI forwarded-user resolver so every verified caller's
 * `email -> subject` pair reaches the gateway's Connections page directory
 * (docs/adr/0046). That page signs people in against the IdP and learns only
 * an email; this is how it finds the `openwebui:<id>` their credentials are
 * stored under.
 *
 * Resolution is never delayed or failed by this: the record is fire-and-forget,
 * and a gateway that is down costs the page a mapping, not the chat a turn.
 * Each pair is sent once per process -- a change of email for a subject (or a
 * failure, after a back-off) sends it again.
 *
 * Only `perUser` identities are recorded. A shared subject mapped to one
 * person's email would hand that person every other caller's connections.
 */
export class PrincipalRecordingResolver implements IdentityResolver {
  /** subject -> email last recorded (or in flight). */
  private readonly recorded = new Map<string, string>();
  /** subject -> when its last record failed. */
  private readonly failedAt = new Map<string, number>();

  constructor(
    private readonly inner: IdentityResolver,
    private readonly sink: { recordPrincipal(email: string, subject: string): Promise<void> },
    private readonly now: () => number = Date.now,
  ) {}

  async resolve(token: string): Promise<Identity | undefined> {
    const identity = await this.inner.resolve(token);
    if (identity?.perUser && identity.email) this.maybeRecord(identity.email.trim().toLowerCase(), identity.subject);
    return identity;
  }

  private maybeRecord(email: string, subject: string): void {
    if (this.recorded.get(subject) === email) return;
    const failed = this.failedAt.get(subject);
    if (failed !== undefined && this.now() - failed < RETRY_AFTER_MS) return;

    this.recorded.set(subject, email);
    this.sink.recordPrincipal(email, subject).then(
      () => this.failedAt.delete(subject),
      (err: unknown) => {
        this.recorded.delete(subject);
        this.failedAt.set(subject, this.now());
        console.error(
          `connections: could not record principal for ${subject}:`,
          err instanceof Error ? err.message : String(err),
        );
      },
    );
  }
}
