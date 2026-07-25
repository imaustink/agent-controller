import type { IdentityLinkPort } from "./gateway-client.js";

/**
 * Providers whose credential is keyed by a CANONICAL, cross-entry-point
 * subject rather than the raw `identity.subject` of whichever entry point
 * happened to resolve the caller.
 *
 * Only the Claude credentials are in this set, and that is deliberate. The
 * `github` link is what PRODUCES the mapping (see
 * {@link resolveCredentialSubject}), so keying it canonically would be
 * circular; it stays keyed by the raw subject, exactly as before. Triage's
 * GitHub writes also still go through the App installation token, untouched
 * by anything here.
 */
const CANONICAL_PROVIDERS: ReadonlySet<string> = new Set(["claude", "claude-remote"]);

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
  return `github:${login.toLowerCase()}`;
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
 * Resolves the subject a given provider's credential is stored under.
 *
 * The Claude credentials (`claude`, `claude-remote`) are the ones a human
 * re-authorizes by hand, and until now they were keyed by `identity.subject`
 * -- which differs per entry point (a shared service subject for
 * GitHub-webhook triage, `openwebui:<id>` for chat), so authorizing in one
 * flow left the other unauthorized. This maps both entry points onto one
 * canonical `github:<login>` key so a single authorization covers both.
 *
 * The login comes from whichever source the entry point actually has:
 * - **Triage / AI review**: `senderLogin`, plumbed through `/invoke`'s event
 *   descriptor -- GitHub itself vouches for it (the webhook signature is
 *   verified upstream in the gateway, which drops the event entirely if the
 *   sender resolves to no identity).
 * - **Chat**: the `githubLogin` on the caller's own `github` identity link,
 *   which they established via the device/authcode flow -- i.e. they proved
 *   control of that account to GitHub.
 *
 * Both are verified; neither is caller-supplied text. A caller cannot name
 * an arbitrary login and inherit someone else's Claude credential.
 *
 * Falls back to the raw subject when no login is resolvable, which preserves
 * the exact pre-change behavior rather than failing the turn -- a
 * non-canonical key still works, it just isn't shared across flows.
 *
 * @param githubGateway The `github`-provider gateway, used ONLY to read an
 * existing link's `githubLogin`. Never starts a link: this is a lookup on a
 * path that must not have side effects.
 */
export async function resolveCredentialSubject(
  provider: string,
  rawSubject: string,
  senderLogin: string | undefined,
  githubGateway: Pick<IdentityLinkPort, "getToken"> | undefined,
): Promise<string> {
  if (!CANONICAL_PROVIDERS.has(provider)) return rawSubject;

  if (senderLogin) return canonicalSubjectForLogin(senderLogin);

  if (!githubGateway) return rawSubject;
  try {
    const link = await githubGateway.getToken("github", rawSubject);
    if (link?.githubLogin) return canonicalSubjectForLogin(link.githubLogin);
  } catch (err) {
    // A lookup failure must not take down the turn: falling back to the raw
    // subject degrades to the old per-entry-point behavior (an extra
    // authorization prompt) instead of a hard error, and the NEXT turn
    // retries the lookup. Logged because a silent fallback here would look
    // identical to "this user never linked GitHub".
    console.error(
      `[credential-subject] github link lookup failed for subject ${rawSubject}; falling back to the raw subject (no cross-flow credential sharing this turn): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return rawSubject;
}
