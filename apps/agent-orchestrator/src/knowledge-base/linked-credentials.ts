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
   * For the single-resource paths — the document reader and the live lookup —
   * which address ONE connection, and so one provider, per call. The
   * multi-member search path uses `delegatedTokens` instead, because a knowledge
   * base can span providers and each must be probed with its own token.
   *
   * Providers are tried in the order given, so the choice is deterministic.
   */
  async delegatedToken(subject: string, providers: string[]): Promise<DelegatedCredential | undefined> {
    for (const provider of providers) {
      const credential = await this.resolveOne(provider, subject);
      if (credential) return credential;
    }
    return undefined;
  }

  /**
   * Returns a credential PER PROVIDER the caller has linked, keyed by provider.
   *
   * All of them, not the first: the probe path can now carry one token per
   * connection, so a knowledge base spanning Confluence, Drive and Slack serves
   * every source the caller has linked the account for — and the searcher turns
   * the ones they have NOT linked into an honest "link this to see more" rather
   * than probing them with the wrong provider's token and dropping them. A
   * provider the caller has not linked is simply absent from the map.
   */
  async delegatedTokens(subject: string, providers: string[]): Promise<Map<string, DelegatedCredential>> {
    const resolved = new Map<string, DelegatedCredential>();
    for (const provider of providers) {
      const credential = await this.resolveOne(provider, subject);
      if (credential) resolved.set(provider, credential);
    }
    return resolved;
  }

  private async resolveOne(provider: string, subject: string): Promise<DelegatedCredential | undefined> {
    // Deliberately NOT caught. A lookup that failed is unknown, and reporting
    // it as absent tells a caller to link an account they already linked — on
    // every turn, while the same record works moments later (docs/adr/0031).
    const token = await this.links.getToken(provider, subject);
    if (!token?.token) return undefined;
    return { token: token.token, principals: await this.principals(provider, subject) };
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
