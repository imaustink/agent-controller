import { signState, verifyState } from "@controller-agent/github-app-auth";
import type { IdentityLinkStore } from "./store.js";
import type { OAuthProviderConfig } from "./providers.js";

/** Matches the device-flow linker's `state` lifetime, so `/wait` can bound itself the same way. */
const AUTH_CODE_STATE_TTL_SECONDS = 600;

/** Refresh this far before expiry, so a token does not die mid-request. */
const REFRESH_SKEW_MS = 60_000;

export interface OAuthAuthCodeLinkerOptions {
  config: OAuthProviderConfig;
  store: IdentityLinkStore;
  /** HMAC secret binding a `state` token to one subject and provider. */
  stateSecret: string;
  /** Must match the provider app's registered redirect URI exactly. */
  redirectUri: string;
  fetchImpl?: typeof fetch;
  /** Injectable clock, for tests. */
  now?: () => number;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}

/**
 * The generic OAuth authorization-code (3LO) linker.
 *
 * `GithubDeviceFlowLinker` already carries an authcode path, but it is
 * GitHub's: GitHub endpoints, a GitHub login lookup, a hardcoded provider
 * name. This is the same flow driven entirely by an {@link OAuthProviderConfig},
 * so a second provider is configuration rather than a fork.
 *
 * Deliberately a sibling rather than a refactor of that class. The GitHub path
 * is the one that works in production today, and the value of generalizing it
 * does not exceed the cost of breaking it.
 */
export class OAuthAuthCodeLinker {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: OAuthAuthCodeLinkerOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    if (options.config.kind !== "authcode") {
      throw new Error(`${options.config.name} is not an authorization-code provider`);
    }
  }

  get provider(): string {
    return this.options.config.name;
  }

  /**
   * Builds the URL the user's browser is sent to, carrying a signed `state`
   * that binds this attempt to one subject and provider.
   *
   * The state is signed rather than stored, so nothing has to be cleaned up if
   * the user abandons the flow, and a gateway restart mid-link does not strand
   * them.
   */
  startAuthCode(subject: string): { authorizeUrl: string; expiresInSeconds: number } {
    const { config, redirectUri, stateSecret } = this.options;
    const state = signState({ provider: config.name, subject }, stateSecret, this.now());

    const url = new URL(config.authorizeUrl);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("state", state);
    url.searchParams.set("scope", config.scopes.join(" "));
    url.searchParams.set("response_type", "code");
    // Atlassian issues a refresh token only when consent is forced; without it
    // a re-link silently produces an access token that dies in an hour with no
    // way to renew it.
    url.searchParams.set("prompt", "consent");

    return { authorizeUrl: url.toString(), expiresInSeconds: AUTH_CODE_STATE_TTL_SECONDS };
  }

  /**
   * Completes the flow from the provider's redirect.
   *
   * Returns `undefined` rather than throwing for every expected bad-request
   * outcome — a tampered, expired or replayed `state`, or the provider
   * rejecting the code — because those are routine callback abuse and expiry,
   * not bugs. Same contract as the GitHub linker's.
   */
  async completeAuthCode(state: string, code: string): Promise<{ subject: string } | undefined> {
    // Same clock that signed it: verifyState defaults to the real one, which
    // would make the injected clock half-honoured and the TTL check meaningless
    // whenever the two disagree.
    const verified = verifyState(
      state,
      this.options.stateSecret,
      AUTH_CODE_STATE_TTL_SECONDS,
      this.now(),
    );
    if (!verified || verified.provider !== this.provider) return undefined;

    let tokens: TokenResponse;
    try {
      tokens = await this.exchange({
        grant_type: "authorization_code",
        code,
        redirect_uri: this.options.redirectUri,
      });
    } catch {
      return undefined;
    }
    if (!tokens.access_token) return undefined;

    await this.options.store.set(this.provider, verified.subject, {
      // Not a GitHub link, so there is no login to record. The field stays on
      // the record for the providers that do have one (docs/adr/0029).
      githubLogin: "",
      accountId: await this.fetchAccountId(tokens.access_token),
      token: tokens.access_token,
      expiresAt: this.expiryFrom(tokens.expires_in),
      refreshToken: tokens.refresh_token,
      refreshExpiresAt: undefined,
    });
    return { subject: verified.subject };
  }

  /**
   * Returns a usable access token for `subject`, refreshing first if it is at
   * or near expiry. `undefined` means "not linked, or the link is dead" — the
   * caller's cue to ask for a re-link.
   */
  async getValidToken(subject: string): Promise<{ token: string } | undefined> {
    const stored = await this.options.store.get(this.provider, subject);
    if (!stored) return undefined;

    const expiresAt = Date.parse(stored.expiresAt);
    const stillFresh = Number.isFinite(expiresAt) && expiresAt - this.now() > REFRESH_SKEW_MS;
    if (stillFresh) return { token: stored.token };

    if (!stored.refreshToken) return undefined;
    return this.refresh(subject, stored.refreshToken);
  }

  /**
   * Exchanges a refresh token for a new credential.
   *
   * ONE INVARIANT DOMINATES THIS METHOD, and it is the same one
   * `claude-auth/credential-refresher.ts` is written around: for a provider
   * that ROTATES (Atlassian does), the instant new tokens come back the old
   * refresh token is dead. From that moment the response is the only living
   * copy of the credential, so it must be persisted — or, failing that, still
   * handed to the caller and complained about loudly — rather than dropped.
   *
   * Dropping it is precisely what produced the `claude-remote`
   * re-authorization loop: the stored copy kept pointing at a spent refresh
   * token, so every subsequent turn asked the user to link again.
   *
   * A refresh we did not complete leaves the stored credential exactly as it
   * was, so a transient failure costs one request rather than the link.
   */
  private async refresh(subject: string, refreshToken: string): Promise<{ token: string } | undefined> {
    let tokens: TokenResponse;
    try {
      tokens = await this.exchange({ grant_type: "refresh_token", refresh_token: refreshToken });
    } catch {
      // Could not reach the provider, or it refused. The stored credential is
      // untouched and still whatever it was.
      return undefined;
    }
    if (!tokens.access_token) return undefined;

    const credential = {
      githubLogin: "",
      accountId: (await this.options.store.get(this.provider, subject))?.accountId,
      token: tokens.access_token,
      expiresAt: this.expiryFrom(tokens.expires_in),
      // A provider that rotates returns a new refresh token; one that does not
      // omits it, and the existing one stays valid.
      refreshToken: tokens.refresh_token ?? (this.options.config.rotatesRefreshToken ? undefined : refreshToken),
      refreshExpiresAt: undefined,
    };

    try {
      await this.options.store.set(this.provider, subject, credential);
    } catch (err) {
      // The old refresh token is already spent, so failing quietly here would
      // strand the link. Hand the caller the token that works and make the
      // persistence failure impossible to miss.
      console.error(
        `[identity-link] CRITICAL: refreshed ${this.provider} for ${subject} but could not persist it. ` +
          `The previous refresh token is now spent, so the stored credential is dead and the user will be ` +
          `asked to re-link. Cause:`,
        err,
      );
    }
    return { token: credential.token };
  }

  private async exchange(params: Record<string, string>): Promise<TokenResponse> {
    const { config, redirectUri } = this.options;
    const response = await this.fetchImpl(config.tokenUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: redirectUri,
        ...params,
      }),
    });
    if (!response.ok) throw new Error(`${config.name} token endpoint returned ${response.status}`);
    return (await response.json()) as TokenResponse;
  }

  /** Best-effort: a missing account id costs provenance, never the link. */
  private async fetchAccountId(token: string): Promise<string | undefined> {
    const identity = this.options.config.identity;
    if (!identity) return undefined;
    try {
      const response = await this.fetchImpl(identity.url, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as Record<string, unknown>;
      const value = body[identity.field];
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * A provider that omits `expires_in` is treated as already expired rather
   * than as never expiring — so the next read refreshes instead of presenting
   * a token whose lifetime nobody knows.
   */
  private expiryFrom(expiresIn: number | undefined): string {
    const seconds = typeof expiresIn === "number" && expiresIn > 0 ? expiresIn : 0;
    return new Date(this.now() + seconds * 1000).toISOString();
  }
}
