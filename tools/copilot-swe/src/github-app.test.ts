import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAppJwt, mintInstallationToken, resolveInstallationId } from "./github-app.js";

function keypair(): { privatePem: string; publicKey: ReturnType<typeof generateKeyPairSync>["publicKey"] } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privatePem: privateKey.export({ type: "pkcs8", format: "pem" }) as string, publicKey };
}

function jsonResponse(body: unknown, ok = true, status = 200): { ok: boolean; status: number; text: () => Promise<string> } {
  return { ok, status, text: async () => JSON.stringify(body) };
}

describe("createAppJwt", () => {
  it("produces a verifiable RS256 JWT with the right claims", () => {
    const { privatePem, publicKey } = keypair();
    const jwt = createAppJwt("123456", privatePem, 1_000);
    const [header, payload, signature] = jwt.split(".");
    expect(header && payload && signature).toBeTruthy();

    const verify = createVerify("RSA-SHA256");
    verify.update(`${header}.${payload}`);
    verify.end();
    expect(verify.verify(publicKey, Buffer.from(signature!, "base64url"))).toBe(true);

    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(claims.iss).toBe("123456");
    expect(claims.iat).toBe(940); // 1000 - 60
    expect(claims.exp).toBe(1540); // 1000 + 540
  });
});

describe("resolveInstallationId", () => {
  it("returns a configured id without any network call", async () => {
    const fetchImpl = vi.fn();
    const id = await resolveInstallationId("jwt", { apiUrl: "https://api.github.com", configuredId: "999", fetchImpl: fetchImpl as never });
    expect(id).toBe("999");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("looks up a repo's installation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ id: 42 }));
    const id = await resolveInstallationId("jwt", { apiUrl: "https://api.github.com", repo: "octo/hello", fetchImpl: fetchImpl as never });
    expect(id).toBe("42");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.github.com/repos/octo/hello/installation");
  });

  it("falls back to the first app installation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse([{ id: 7 }, { id: 8 }]));
    const id = await resolveInstallationId("jwt", { apiUrl: "https://api.github.com", fetchImpl: fetchImpl as never });
    expect(id).toBe("7");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.github.com/app/installations");
  });
});

describe("mintInstallationToken", () => {
  it("POSTs and returns the token", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ token: "ghs_secret", expires_at: "2026-01-01T00:00:00Z" }));
    const token = await mintInstallationToken("jwt", "42", { apiUrl: "https://api.github.com", fetchImpl: fetchImpl as never });
    expect(token.token).toBe("ghs_secret");
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(fetchImpl.mock.calls[0]![1].method).toBe("POST");
  });

  it("throws on an API error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ message: "bad" }, false, 401));
    await expect(mintInstallationToken("jwt", "42", { apiUrl: "https://api.github.com", fetchImpl: fetchImpl as never })).rejects.toThrow();
  });
});
