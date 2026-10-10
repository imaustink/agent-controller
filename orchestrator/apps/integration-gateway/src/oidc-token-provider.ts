/**
 * Fetches, caches, and transparently refreshes an OIDC `client_credentials`
 * access token (e.g. from Pocket ID -- see imaustink/homelab's
 * kubernetes/manifests/agent-controller/README.md) instead of reading a
 * static, manually-rotated `GATEWAY_ORCHESTRATOR_TOKEN` env var. Pocket ID's
 * client_credentials tokens expire in a fixed 1 hour with no refresh token
 * (fosite default, not configurable) -- this was previously a documented,
 * unbuilt follow-up ("integration-gateway token refresh (not yet built)")
 * that required someone to notice auth had gone stale and manually re-mint
 * the Secret.
 */
export interface OidcTokenProviderOptions {
  /** OIDC token endpoint, e.g. `https://pocket-id.kurpuis.com/api/oidc/token`. */
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  /** RFC 8707 `resource` param -- the audience this token should be scoped to (agent-orchestrator's own URL). */
  resource?: string;
  /**
   * Seconds of buffer subtracted from the token's `expires_in` before it's
   * considered stale and due for a refresh -- refreshing a little early
   * avoids a request racing an exact-expiry boundary. Default 60s.
   */
  refreshBufferSeconds?: number;
  /** Fallback token lifetime (seconds) if the token endpoint omits `expires_in`. Default 3600 (Pocket ID's fixed lifetime). */
  defaultExpiresInSeconds?: number;
  fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  now?: () => number;
}

interface TokenResponse {
  access_token?: unknown;
  expires_in?: unknown;
}

/**
 * Fetches an OIDC `client_credentials` token on first use and caches it in
 * memory, transparently refetching once the cached token is within its
 * refresh buffer of expiring. Concurrent `getToken()` calls while a refresh
 * is already in flight share the same request rather than each firing their
 * own (important here: a burst of webhook events must not stampede the
 * token endpoint).
 */
export class OidcTokenProvider {
  private cached: { token: string; expiresAtMs: number } | undefined;
  private inFlight: Promise<string> | undefined;

  constructor(private readonly options: OidcTokenProviderOptions) {}

  async getToken(): Promise<string> {
    const now = (this.options.now ?? Date.now)();
    if (this.cached && this.cached.expiresAtMs > now) return this.cached.token;
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.fetchToken(now).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async fetchToken(now: number): Promise<string> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      ...(this.options.resource ? { resource: this.options.resource } : {}),
    });

    const res = await fetchImpl(this.options.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      throw new Error(`OIDC token endpoint rejected the client_credentials request: ${res.status} ${await res.text()}`);
    }

    const parsed = (await res.json()) as TokenResponse;
    if (typeof parsed.access_token !== "string" || !parsed.access_token) {
      throw new Error("OIDC token endpoint response is missing access_token");
    }
    const expiresInSeconds =
      typeof parsed.expires_in === "number" ? parsed.expires_in : (this.options.defaultExpiresInSeconds ?? 3600);
    const bufferMs = (this.options.refreshBufferSeconds ?? 60) * 1000;

    this.cached = { token: parsed.access_token, expiresAtMs: now + expiresInSeconds * 1000 - bufferMs };
    return parsed.access_token;
  }
}
