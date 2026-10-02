import { describe, expect, it, vi } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { GoogleServiceCredential, parseServiceAccountKey, type TokenFetch } from "./google-auth.js";

const { publicKey, privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function saKey(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "service_account",
    client_email: "kb-sync@proj.iam.gserviceaccount.com",
    private_key: privateKey,
    token_uri: "https://oauth2.googleapis.com/token",
    ...overrides,
  });
}

/** A token endpoint that records the assertion it was sent. */
function tokenEndpoint(accessToken = "ya29.minted", expiresIn = 3600) {
  const calls: Array<Record<string, string>> = [];
  const fetchImpl: TokenFetch = async (_url, init) => {
    calls.push(Object.fromEntries(new URLSearchParams(init.body)));
    return { ok: true, status: 200, json: async () => ({ access_token: accessToken, expires_in: expiresIn }) };
  };
  return { calls, fetchImpl: vi.fn(fetchImpl) as unknown as TokenFetch & { mock: { calls: unknown[] } } };
}

describe("parseServiceAccountKey", () => {
  it("recognizes a service-account key", () => {
    expect(parseServiceAccountKey(saKey())?.client_email).toBe("kb-sync@proj.iam.gserviceaccount.com");
  });

  it("returns undefined for a raw access token or non-key JSON", () => {
    expect(parseServiceAccountKey("ya29.a0Af...")).toBeUndefined();
    expect(parseServiceAccountKey("email@x.com:api-token")).toBeUndefined();
    expect(parseServiceAccountKey(JSON.stringify({ type: "authorized_user" }))).toBeUndefined();
    expect(parseServiceAccountKey(JSON.stringify({ type: "service_account", client_email: "x" }))).toBeUndefined();
  });
});

describe("GoogleServiceCredential.bearer", () => {
  it("passes a raw access token through unchanged, with no token call", async () => {
    const { fetchImpl } = tokenEndpoint();
    const creds = new GoogleServiceCredential(fetchImpl);
    expect(await creds.bearer("ya29.raw")).toBe("ya29.raw");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("mints an access token from a key, with a correctly signed JWT assertion", async () => {
    const { calls, fetchImpl } = tokenEndpoint();
    const creds = new GoogleServiceCredential(fetchImpl, undefined, () => 1_000_000);

    expect(await creds.bearer(saKey())).toBe("ya29.minted");

    const assertion = calls[0]!.assertion!;
    expect(calls[0]!.grant_type).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, payload, signature] = assertion.split(".");
    // The signature must verify against the key's PUBLIC half.
    const ok = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature!, "base64url"));
    expect(ok).toBe(true);
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("kb-sync@proj.iam.gserviceaccount.com");
    expect(claims.scope).toBe("https://www.googleapis.com/auth/drive.readonly");
    expect(claims.aud).toBe("https://oauth2.googleapis.com/token");
  });

  it("caches a minted token and re-mints only after it nears expiry", async () => {
    let now = 1_000_000;
    const { fetchImpl } = tokenEndpoint("ya29.first", 3600);
    const creds = new GoogleServiceCredential(fetchImpl, undefined, () => now);

    await creds.bearer(saKey());
    await creds.bearer(saKey());
    // Second call inside the token's lifetime reuses the cache.
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Past expiry (minus skew) → a fresh mint.
    now += 3600_000;
    await creds.bearer(saKey());
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces a token-endpoint failure instead of silently using nothing", async () => {
    const failing: TokenFetch = async () => ({ ok: false, status: 400, json: async () => ({}), text: async () => "invalid_grant" });
    const creds = new GoogleServiceCredential(failing);
    await expect(creds.bearer(saKey())).rejects.toThrow(/token exchange failed: 400/);
  });
});
