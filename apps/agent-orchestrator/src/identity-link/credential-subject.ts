import type { IdentityLinkPort } from "./gateway-client.js";


/**
 * The canonical credential subject for a GitHub login. Lower-cased because
 * GitHub logins are case-insensitive for identity purposes but are echoed
 * back with their original casing in webhook payloads vs. the OAuth user
 * API -- without normalizing, `Imaustink` from a webhook and `imaustink`
 * from a device-flow link would key two different Redis records and
 * re-prompt exactly the way this whole change exists to prevent.
 *
 * The `github:` prefix keeps these from ever colliding with a raw upstream
 * subject, the same namespacing discipline `openwebui:<id>` already uses.
 */
export function canonicalSubjectForLogin(login: string): string {
  return `${CANONICAL_PRINCIPAL_PREFIX}${login.toLowerCase()}`;
}

/**
 * Namespace marking a principal as CANONICAL -- resolved from a verified GitHub
 * identity -- as opposed to the raw-subject fallback {@link resolvePrincipal}
 * returns when no login could be established.
 */
export const CANONICAL_PRINCIPAL_PREFIX = "github:";

/**
 * Whether a principal is the canonical, cross-entry-point one or merely a raw
 * entry-point subject standing in for itself.
 *
 * The distinction is what the authorization pre-flight acts on: a caller whose
 * principal is still their raw subject gets no credential sharing with their
 * other entry points, so a turn that needs a cross-entry-point credential can
 * offer to establish the mapping first (docs/adr/0031).
 *
 * A prefix test is sound because every entry-point subject is either namespaced
 * by its own resolver (`openwebui:<id>`) or an IdP `sub`, and none of them can
 * be `github:<login>` -- that namespace exists solely for principals.
 */
export function isCanonicalPrincipal(principal: string): boolean {
  return principal.startsWith(CANONICAL_PRINCIPAL_PREFIX);
}

/**
 * The caller's GitHub login, or `undefined` if none can be established.
 *
 * Deliberately independent of an Agent's `identityProviders` (docs/adr/0030):
 * knowing WHO the caller is and provisioning them a GitHub *credential* are
 * different concerns, and conflating them is what forced `claude-code-swe-agent`
 * to declare the `github` provider purely to obtain a mapping -- which
 * activated the delegated-write path and produced a production 401. This is a
 * read-only lookup with no side effects: it never starts a link.
 *
 * Same two verified sources as {@link resolveCredentialSubject}: a
 * signature-verified webhook's sender, or a link the caller established by
 * proving control of the account.
 */
export async function resolveActorLogin(
  rawSubject: string,
  senderLogin: string | undefined,
  githubGateway: Pick<IdentityLinkPort, "getToken"> | undefined,
): Promise<string | undefined> {
  if (senderLogin) return senderLogin;
  if (!githubGateway) return undefined;
  try {
    return (await githubGateway.getToken("github", rawSubject))?.githubLogin;
  } catch {
    // A failed lookup must not fail the turn -- the agent simply falls back
    // to its own resolution, exactly as before this existed.
    return undefined;
  }
}

/**
 * Resolves the caller's PRINCIPAL -- the stable identifier for the human,
 * independent of which entry point they arrived through (docs/adr/0030 §6).
 *
 * `ClaudeTokenStore` used to key by `identity.subject`, and the two entry
 * points resolve different ones: a shared OIDC service subject for
 * GitHub-webhook triage, `openwebui:<id>` for chat. Authorizing in one flow
 * therefore left the other unauthorized. Keying by principal converges them.
 *
 * The GitHub identity is used as the principal because it is the only
 * identifier both flows can reach, from whichever verified source the entry
 * point has:
 * - **Webhook**: the sender GitHub itself vouched for (signature verified
 *   upstream; the gateway drops the event if the sender resolves to nothing).
 * - **Chat**: the `githubLogin` on a link the caller established by proving
 *   control of that account.
 *
 * Neither is caller-supplied text, so nobody can name a login and inherit
 * another person's credentials.
 *
 * Falls back to the raw subject acting as its own principal when no GitHub
 * identity is resolvable. That is a working state, not a failure: the caller
 * simply gets no cross-entry-point sharing, exactly as before principals
 * existed.
 */
export async function resolvePrincipal(
  rawSubject: string,
  senderLogin: string | undefined,
  githubGateway: Pick<IdentityLinkPort, "getToken"> | undefined,
): Promise<string> {
  const login = await resolveActorLogin(rawSubject, senderLogin, githubGateway);
  return login ? canonicalSubjectForLogin(login) : rawSubject;
}
