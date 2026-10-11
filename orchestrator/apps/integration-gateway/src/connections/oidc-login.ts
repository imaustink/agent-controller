import { createHash, randomBytes } from "node:crypto";

/**
 * Browser sign-in for the Connections page, against any standards-compliant
 * OpenID Connect provider -- Pocket ID in one deployment, Keycloak in another
 * (docs/adr/0046). Nothing here is provider-specific: the issuer's discovery
 * document supplies every endpoint, so switching IdPs is three config values.
 *
 * Authorization-code flow with PKCE and a nonce. The ID token is NOT
 * signature-verified, deliberately: it arrives on the back channel, straight
 * from the token endpoint over TLS in exchange for our client secret, and OIDC
 * Core §3.1.3.7(6) allows TLS server validation to stand in for the signature
 * check in exactly that case. Its `iss`, `aud`, `exp` and `nonce` are still
 * checked, which is what binds it to this login attempt.
 */

export interface OidcLoginConfig {
  /** Issuer URL, e.g. `https://pocket-id.example.com` or `https://kc.example.com/realms/acme`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Space-separated. Must include `openid` and `email`. */
  scopes: string;
  /**
   * Accept an `email` the IdP does not mark `email_verified`. Off by default
   * and should stay off: the email is what maps a sign-in to a chat user's
   * stored credentials, so an unverified one lets whoever typed it claim
   * someone else's connections.
   */
  allowUnverifiedEmail: boolean;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
}

/** What the page keeps between redirecting to the IdP and handling its callback. */
export interface PendingLogin {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export type LoginResult =
  | { ok: true; email: string; idpSubject: string }
  | { ok: false; reason: "exchange-failed" | "invalid-id-token" | "no-email" | "email-unverified" };

const DISCOVERY_TTL_MS = 60 * 60 * 1000;

export class OidcLoginClient {
  private discovery: { value: Discovery; fetchedAt: number } | undefined;

  constructor(
    private readonly config: OidcLoginConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  /** Starts a login: the URL to send the browser to, and what to remember until it comes back. */
  async begin(): Promise<{ authorizeUrl: string; pending: PendingLogin }> {
    const discovery = await this.discover();
    const pending: PendingLogin = {
      state: randomBytes(16).toString("base64url"),
      nonce: randomBytes(16).toString("base64url"),
      codeVerifier: randomBytes(32).toString("base64url"),
    };
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes);
    url.searchParams.set("state", pending.state);
    url.searchParams.set("nonce", pending.nonce);
    url.searchParams.set("code_challenge", createHash("sha256").update(pending.codeVerifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    return { authorizeUrl: url.toString(), pending };
  }

  /** Completes a login. The caller has already matched `state` against `pending`. */
  async complete(code: string, pending: PendingLogin): Promise<LoginResult> {
    const discovery = await this.discover();
    let idToken: unknown;
    try {
      const response = await this.fetchImpl(discovery.token_endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          accept: "application/json",
          // client_secret_basic: the OIDC default, and supported by both Pocket
          // ID and Keycloak. Each half is form-encoded first, per RFC 6749 §2.3.1.
          authorization: `Basic ${Buffer.from(
            `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
          ).toString("base64")}`,
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: this.config.redirectUri,
          code_verifier: pending.codeVerifier,
        }).toString(),
      });
      if (!response.ok) return { ok: false, reason: "exchange-failed" };
      idToken = ((await response.json()) as { id_token?: unknown }).id_token;
    } catch {
      return { ok: false, reason: "exchange-failed" };
    }
    if (typeof idToken !== "string") return { ok: false, reason: "invalid-id-token" };

    const claims = decodeJwtPayload(idToken);
    if (!claims) return { ok: false, reason: "invalid-id-token" };
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (
      claims.iss !== discovery.issuer ||
      !aud.includes(this.config.clientId) ||
      typeof claims.exp !== "number" ||
      claims.exp * 1000 <= this.now() ||
      claims.nonce !== pending.nonce ||
      typeof claims.sub !== "string"
    ) {
      return { ok: false, reason: "invalid-id-token" };
    }

    const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
    if (!email) return { ok: false, reason: "no-email" };
    // Some IdPs send the string "true"; anything else is unverified.
    const verified = claims.email_verified === true || claims.email_verified === "true";
    if (!verified && !this.config.allowUnverifiedEmail) return { ok: false, reason: "email-unverified" };
    return { ok: true, email, idpSubject: claims.sub };
  }

  private async discover(): Promise<Discovery> {
    if (this.discovery && this.now() - this.discovery.fetchedAt < DISCOVERY_TTL_MS) return this.discovery.value;
    const base = this.config.issuer.replace(/\/+$/, "");
    const response = await this.fetchImpl(`${base}/.well-known/openid-configuration`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) throw new Error(`OIDC discovery failed for ${base}: HTTP ${response.status}`);
    const value = (await response.json()) as Partial<Discovery>;
    if (!value.issuer || !value.authorization_endpoint || !value.token_endpoint) {
      throw new Error(`OIDC discovery document for ${base} is missing required endpoints`);
    }
    this.discovery = { value: value as Discovery, fetchedAt: this.now() };
    return this.discovery.value;
  }
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | undefined {
  const parts = jwt.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
