import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type KeyLike } from "jose";
import { OidcIdentityResolver } from "./oidc-identity-resolver.js";

const ISSUER = "https://issuer.example.com";
const AUDIENCE = "agent-orchestrator";
const KID = "test-key";

describe("OidcIdentityResolver", () => {
  let jwks: JWTVerifyGetKey;
  let privateKey: KeyLike;

  beforeAll(async () => {
    const { publicKey, privateKey: priv } = await generateKeyPair("RS256");
    privateKey = priv;
    const publicJwk = await exportJWK(publicKey);
    jwks = createLocalJWKSet({ keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }] });
  });

  function sign(
    claims: Record<string, unknown>,
    opts: { issuer?: string; audience?: string; expired?: boolean; key?: KeyLike } = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: KID })
      .setIssuedAt()
      .setIssuer(opts.issuer ?? ISSUER)
      .setAudience(opts.audience ?? AUDIENCE)
      .setExpirationTime(opts.expired ? "-10s" : "1h")
      .sign(opts.key ?? privateKey);
  }

  function makeResolver(rolesClaim = "roles") {
    return new OidcIdentityResolver({ issuer: ISSUER, audience: AUDIENCE, rolesClaim, jwks });
  }

  it("resolves a valid token's subject and roles", async () => {
    const token = await sign({ sub: "alice", roles: ["reader", "writer"] });
    await expect(makeResolver().resolve(token)).resolves.toEqual({ subject: "alice", roles: ["reader", "writer"] });
  });

  it("supports a nested claim path for roles (e.g. Keycloak realm_access.roles)", async () => {
    const token = await sign({ sub: "bob", realm_access: { roles: ["admin"] } });
    await expect(makeResolver("realm_access.roles").resolve(token)).resolves.toEqual({
      subject: "bob",
      roles: ["admin"],
    });
  });

  it("resolves to zero roles when the roles claim is missing (still authenticated, fails closed downstream)", async () => {
    const token = await sign({ sub: "carol" });
    await expect(makeResolver().resolve(token)).resolves.toEqual({ subject: "carol", roles: [] });
  });

  it("filters out non-string entries in the roles claim", async () => {
    const token = await sign({ sub: "dave", roles: ["reader", 42, null] });
    await expect(makeResolver().resolve(token)).resolves.toEqual({ subject: "dave", roles: ["reader"] });
  });

  it("skips audience verification when none is configured", async () => {
    const resolver = new OidcIdentityResolver({ issuer: ISSUER, audience: undefined, rolesClaim: "roles", jwks });
    const token = await sign({ sub: "alice", roles: ["reader"] }, { audience: "anything" });
    await expect(resolver.resolve(token)).resolves.toEqual({ subject: "alice", roles: ["reader"] });
  });

  it("fails closed for an expired token", async () => {
    const token = await sign({ sub: "alice", roles: ["reader"] }, { expired: true });
    await expect(makeResolver().resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed for the wrong issuer", async () => {
    const token = await sign({ sub: "alice", roles: ["reader"] }, { issuer: "https://evil.example.com" });
    await expect(makeResolver().resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed for the wrong audience", async () => {
    const token = await sign({ sub: "alice", roles: ["reader"] }, { audience: "someone-else" });
    await expect(makeResolver().resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed for a malformed token", async () => {
    await expect(makeResolver().resolve("not-a-jwt")).resolves.toBeUndefined();
  });

  it("fails closed when signed by an untrusted key", async () => {
    const { privateKey: otherKey } = await generateKeyPair("RS256");
    const token = await sign({ sub: "alice", roles: ["reader"] }, { key: otherKey });
    await expect(makeResolver().resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed when the sub claim is missing", async () => {
    const token = await sign({ roles: ["reader"] });
    await expect(makeResolver().resolve(token)).resolves.toBeUndefined();
  });

  it("fails closed when the sub claim is not a string", async () => {
    const token = await sign({ sub: 123, roles: ["reader"] });
    await expect(makeResolver().resolve(token)).resolves.toBeUndefined();
  });
});
