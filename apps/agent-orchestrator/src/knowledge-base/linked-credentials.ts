import type { IdentityLinkPort } from "../identity-link/gateway-client.js";
import type { DelegatedCredential, DelegatedCredentialResolver } from "./searcher.js";

/**
 * Resolves the calling user's own credential for a knowledge base's providers.
 *
 * This is the production `DelegatedCredentialResolver`. Without it every
 * knowledge-base search answered "link your account first" — correctly, since
 * probing on the ingestion credential would answer a different question,
 * permissively (docs/adr/0040) — but unconditionally, including for callers who
 * had linked.
 *
 * PARITY: `LinkedCredentials` in
 * `engines/temporal/internal/temporal/activities/delegated_credentials.go`.
 */
export class LinkedCredentials implements DelegatedCredentialResolver {
  constructor(private readonly links: IdentityLinkPort) {}

  /**
   * Returns the FIRST provider's credential this caller holds.
   *
   * First, not all: the probe path carries one delegated token per turn, so a
   * knowledge base spanning two providers can only be served by one of them
   * today — a mixed Confluence-and-Slack base will probe Slack candidates with
   * an Atlassian token and drop them. A real limitation, belonging to the
   * prober's shape rather than here. Providers are tried in the order the
   * knowledge base declares, so the choice is deterministic.
   */
  async delegatedToken(subject: string, providers: string[]): Promise<DelegatedCredential | undefined> {
    for (const provider of providers) {
      // Deliberately NOT caught. A lookup that failed is unknown, and reporting
      // it as absent tells a caller to link an account they already linked — on
      // every turn, while the same record works moments later (docs/adr/0031).
      const token = await this.links.getToken(provider, subject);
      if (!token?.token) continue;

      return { token: token.token, principals: await this.principals(provider, subject) };
    }
    return undefined;
  }

  /**
   * The provider-side identity this credential acts as, for the ACL mirror.
   *
   * Best-effort: it feeds a pre-filter that can only save probes, and
   * `preFilter` is written so an absent or partial set costs latency rather
   * than correctness. Failing a search that would otherwise succeed, to protect
   * an optimization, would be the wrong trade.
   *
   * Only the USER principal is resolved. Group membership needs a provider call
   * nothing makes yet, so `preFilter` declines to exclude on group restrictions
   * at all — the safe direction, and one that starts working by itself the day
   * groups are supplied.
   */
  private async principals(provider: string, subject: string): Promise<string[] | undefined> {
    try {
      const accountId = await this.links.getLinkedAccountId?.(provider, subject);
      if (accountId) return [`user:${accountId}`];

      const login = await this.links.getLinkedLogin?.(provider, subject);
      if (login) return [`user:${login}`];
    } catch {
      // See above: an unavailable identity endpoint costs probes, not answers.
    }
    return undefined;
  }
}
