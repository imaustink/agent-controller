import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { OidcLoginClient, type OidcLoginConfig } from "./oidc-login.js";

const NOW = Date.parse("2026-10-03T12:00:00Z");
// A Keycloak-shaped issuer: the realm is part of the path, so discovery must
// be appended to it rather than to the host.
const ISSUER = "https://kc.example.com/realms/acme";

const CONFIG: OidcLoginConfig = {
  issuer: ISSUER,
  clientId: "connections",
  clientSecret: "s3cret",
  redirectUri: "https://gw.example.com/connections/callback",
  scopes: "openid email profile",
  allowUnverifiedEmail: false,
};

function json(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 400, json: async () => body } as unknown as Response;
}

function idToken(claims: Record<string, unknown>): string {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  return `${b64({ alg: "RS256" })}.${b64(claims)}.sig`;
}

function client(tokenClaims: Record<string, unknown> | undefined, config: Partial<OidcLoginConfig> = {}) {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    if (String(url) === `${ISSUER}/.well-known/openid-configuration`) {
      return json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
        token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
      });
    }
    return tokenClaims ? json({ id_token: idToken(tokenClaims) }) : json({ error: "invalid_grant" }, false);
  });
  return { fetchImpl, oidc: new OidcLoginClient({ ...CONFIG, ...config }, fetchImpl as unknown as typeof fetch, () => NOW) };
}

const good = (nonce: string, extra: Record<string, unknown> = {}) => ({
  iss: ISSUER,
  aud: "connections",
  sub: "kc-user-1",
  exp: NOW / 1000 + 300,
  nonce,
  email: "Ada@Example.com",
  email_verified: true,
  ...extra,
});

describe("OidcLoginClient", () => {
  it("builds a PKCE authorization request from discovery", async () => {
    const { oidc } = client(undefined);
    const { authorizeUrl, pending } = await oidc.begin();
    const url = new URL(authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(url.searchParams.get("client_id")).toBe("connections");
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(url.searchParams.get("nonce")).toBe(pending.nonce);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(pending.codeVerifier).digest("base64url"),
    );
  });

  it("returns the normalized, verified email", async () => {
    const { oidc, fetchImpl } = client(good("n1"));
    const result = await oidc.complete("code", { state: "s", nonce: "n1", codeVerifier: "v" });

    expect(result).toEqual({ ok: true, email: "ada@example.com", idpSubject: "kc-user-1" });
    const [, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(String(init.body)).toContain("code_verifier=v");
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Basic ${Buffer.from("connections:s3cret").toString("base64")}`,
    );
  });

  it("accepts an audience array", async () => {
    const { oidc } = client(good("n1", { aud: ["account", "connections"] }));
    expect((await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).ok).toBe(true);
  });

  it.each([
    ["a different nonce", { nonce: "replayed" }],
    ["another issuer", { iss: "https://evil.example.com" }],
    ["another audience", { aud: "someone-else" }],
    ["an expired token", { exp: NOW / 1000 - 1 }],
  ])("rejects %s", async (_label, override) => {
    const { oidc } = client(good("n1", override));
    expect(await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).toEqual({
      ok: false,
      reason: "invalid-id-token",
    });
  });

  // The email is what selects whose credentials the page manages.
  it("refuses an unverified email by default", async () => {
    const { oidc } = client(good("n1", { email_verified: false }));
    expect(await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).toEqual({
      ok: false,
      reason: "email-unverified",
    });
  });

  it("treats a missing email_verified claim as unverified", async () => {
    const { oidc } = client(good("n1", { email_verified: undefined }));
    expect((await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).ok).toBe(false);
  });

  it("accepts the string form some IdPs send", async () => {
    const { oidc } = client(good("n1", { email_verified: "true" }));
    expect((await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).ok).toBe(true);
  });

  it("accepts an unverified email only when explicitly allowed", async () => {
    const { oidc } = client(good("n1", { email_verified: false }), { allowUnverifiedEmail: true });
    expect((await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).ok).toBe(true);
  });

  it("reports a refused code exchange", async () => {
    const { oidc } = client(undefined);
    expect(await oidc.complete("c", { state: "s", nonce: "n1", codeVerifier: "v" })).toEqual({
      ok: false,
      reason: "exchange-failed",
    });
  });
});
