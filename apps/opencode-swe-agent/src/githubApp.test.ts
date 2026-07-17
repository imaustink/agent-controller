import { generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mintInstallationToken, resolveGithubToken, signAppJwt } from "./githubApp.js";

let privateKey: string;
let publicKey: string;

beforeAll(() => {
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  privateKey = pair.privateKey;
  publicKey = pair.publicKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("signAppJwt", () => {
  it("produces a compact JWT with a valid RS256 signature and correct claims", () => {
    const now = 1_700_000_000_000;
    const jwt = signAppJwt("12345", privateKey, now);
    const [headerB64, payloadB64, sigB64] = jwt.split(".");
    expect(headerB64 && payloadB64 && sigB64).toBeTruthy();

    const header = JSON.parse(Buffer.from(headerB64!, "base64url").toString());
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });

    const payload = JSON.parse(Buffer.from(payloadB64!, "base64url").toString());
    expect(payload.iss).toBe("12345");
    expect(payload.iat).toBe(Math.floor(now / 1000) - 60);
    expect(payload.exp).toBe(Math.floor(now / 1000) + 600);

    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = Buffer.from(sigB64!, "base64url");
    expect(cryptoVerify("RSA-SHA256", Buffer.from(signingInput), publicKey, signature)).toBe(true);
  });
});

describe("mintInstallationToken", () => {
  it("POSTs the App JWT and returns the installation token", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ token: "ghs_abc123", expires_at: "2026-07-17T12:00:00Z" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await mintInstallationToken(
      { appId: "1", privateKey, installationId: "999" },
      "https://api.github.com",
      1_700_000_000_000,
    );

    expect(result).toEqual({ token: "ghs_abc123", expiresAt: "2026-07-17T12:00:00Z" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.github.com/app/installations/999/access_tokens",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Accept: "application/vnd.github+json" }),
      }),
    );
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Bearer ey/);
  });

  it("throws with response detail on a non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "installation not found" }),
    );
    await expect(
      mintInstallationToken({ appId: "1", privateKey, installationId: "999" }, "https://api.github.com", Date.now()),
    ).rejects.toThrow(/403.*installation not found/s);
  });

  it("throws if the response has no token field", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({}) }));
    await expect(
      mintInstallationToken({ appId: "1", privateKey, installationId: "999" }, "https://api.github.com", Date.now()),
    ).rejects.toThrow(/no token field/);
  });
});

describe("resolveGithubToken", () => {
  const baseConfig = {
    githubToken: "",
    githubAppId: "",
    githubAppPrivateKey: "",
    githubAppInstallationId: "",
    githubApiUrl: "https://api.github.com",
  };

  it("falls back to the static PAT when no App fields are set", async () => {
    const token = await resolveGithubToken({ ...baseConfig, githubToken: "github_pat_xyz" });
    expect(token).toBe("github_pat_xyz");
  });

  it("prefers a minted installation token when all three App fields are set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 201, json: async () => ({ token: "ghs_minted" }) }),
    );
    const token = await resolveGithubToken({
      ...baseConfig,
      githubToken: "github_pat_should_be_ignored",
      githubAppId: "1",
      githubAppPrivateKey: privateKey,
      githubAppInstallationId: "999",
    });
    expect(token).toBe("ghs_minted");
  });

  it("rejects a partial App configuration instead of silently falling back", async () => {
    await expect(
      resolveGithubToken({ ...baseConfig, githubToken: "github_pat_xyz", githubAppId: "1" }),
    ).rejects.toThrow(/Partial GitHub App configuration/);
  });

  it("throws when neither a PAT nor App credentials are configured", async () => {
    await expect(resolveGithubToken({ ...baseConfig })).rejects.toThrow(/GitHub credentials are required/);
  });
});
