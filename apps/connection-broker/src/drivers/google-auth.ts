import { createSign } from "node:crypto";

/**
 * Turns a connection's Google service credential into a usable bearer token —
 * refreshing it itself, so ingestion never depends on a human pasting a token.
 *
 * The credential in the Secret may be either:
 *
 *   - a GCP SERVICE-ACCOUNT KEY (the downloaded JSON). The driver signs a JWT
 *     with its private key and exchanges it for a ~1h `drive.readonly` access
 *     token, caches it, and re-mints before expiry. No human in the loop. This
 *     is the recommended shape.
 *   - a raw access token (e.g. `gcloud auth print-access-token`). Used verbatim,
 *     for backward compatibility — but it expires in ~1h with nothing to refresh
 *     it, which is the failure this module exists to remove. Prefer the key.
 *
 * Deliberately no `googleapis`/`google-auth-library` dependency: the broker
 * holds every client's third-party credentials, so keeping its footprint (and
 * its transitive supply chain) small is worth a few lines of `node:crypto`.
 *
 * NOTE for EKS: the keyless end-state is Google Workload Identity Federation via
 * IRSA (no stored key at all). That needs GCP-side pool setup; this keyed path
 * is the portable interim, and the driver boundary stays the same so swapping to
 * federation later is contained to this file.
 */

/** The fields this module reads from a service-account key JSON. */
export interface ServiceAccountKey {
  type: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/** POST-capable fetch for the token endpoint (the driver's own FetchLike is GET-only). */
export type TokenFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text?(): Promise<string> }>;

const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** Re-mint this far before expiry so a token never dies mid-sync. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Parses a service-account key, or returns undefined if the string is not one
 * (an opaque access token, or anything that is not a well-formed SA key JSON).
 *
 * Shape-detected, not heuristic on the token text: an SA key is JSON with
 * `type: "service_account"` and both a `client_email` and a `private_key`. A
 * raw access token is neither JSON nor any of those, so the two can't be
 * confused.
 */
export function parseServiceAccountKey(credential: string): ServiceAccountKey | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(credential);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const key = parsed as Partial<ServiceAccountKey>;
  if (key.type !== "service_account" || !key.client_email || !key.private_key) return undefined;
  return { type: key.type, client_email: key.client_email, private_key: key.private_key, token_uri: key.token_uri };
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/** Signs the service-account JWT assertion (RS256), as Google's token endpoint expects. */
function signAssertion(key: ServiceAccountKey, scopes: string[], nowMs: number): string {
  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
  const iat = Math.floor(nowMs / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: key.client_email,
    scope: scopes.join(" "),
    aud: tokenUri,
    iat,
    exp: iat + 3600,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signature = createSign("RSA-SHA256").update(signingInput).sign(key.private_key);
  return `${signingInput}.${base64url(signature)}`;
}

/** Exchanges a signed assertion for an access token. */
export async function mintAccessToken(
  key: ServiceAccountKey,
  scopes: string[],
  fetchImpl: TokenFetch,
  nowMs: number,
): Promise<{ accessToken: string; expiresAtMs: number }> {
  const tokenUri = key.token_uri ?? DEFAULT_TOKEN_URI;
  const assertion = signAssertion(key, scopes, nowMs);
  const response = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: JWT_BEARER_GRANT, assertion }).toString(),
  });
  if (!response.ok) {
    const detail = (await response.text?.()) ?? "";
    throw new Error(`google token exchange failed: ${response.status} ${detail.slice(0, 200)}`);
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) throw new Error("google token exchange returned no access_token");
  return { accessToken: body.access_token, expiresAtMs: nowMs + (body.expires_in ?? 3600) * 1000 };
}

/**
 * Resolves a connection's Google service credential to a bearer token, caching
 * and refreshing a key-minted token. One instance per driver (one connection),
 * so the cache is naturally scoped to that connection's credential.
 */
export class GoogleServiceCredential {
  private cached?: { token: string; expiresAtMs: number; fingerprint: string };

  constructor(
    private readonly fetchImpl: TokenFetch = globalThis.fetch as unknown as TokenFetch,
    private readonly scopes: string[] = ["https://www.googleapis.com/auth/drive.readonly"],
    private readonly now: () => number = Date.now,
  ) {}

  async bearer(credential: string | undefined): Promise<string> {
    if (!credential) throw new Error("no credential supplied for a gdrive request");

    const key = parseServiceAccountKey(credential);
    // A raw access token: used as-is (and cannot be refreshed — prefer a key).
    if (!key) return credential;

    // Fingerprint the key so a rotated credential is not served from a stale
    // cache; never the private key itself.
    const fingerprint = `${key.client_email}:${key.private_key.length}`;
    if (
      this.cached &&
      this.cached.fingerprint === fingerprint &&
      this.cached.expiresAtMs - this.now() > REFRESH_SKEW_MS
    ) {
      return this.cached.token;
    }

    const { accessToken, expiresAtMs } = await mintAccessToken(key, this.scopes, this.fetchImpl, this.now());
    this.cached = { token: accessToken, expiresAtMs, fingerprint };
    return accessToken;
  }
}
