import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { JwksTokenAuthenticator, TICK_TOKEN_AUDIENCE, tickUsername, type IssuerKeys } from "./tick-auth.js";

const ISSUER = "https://kubernetes.default.svc.cluster.local";
const SUB = "system:serviceaccount:ns:eventsource-x";
const NOW = 1_800_000_000_000;

let key: CryptoKey;
let jwk: JWK;
let otherKey: CryptoKey;
let otherJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  key = pair.privateKey;
  jwk = { ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256", use: "sig" };
  const other = await generateKeyPair("RS256");
  otherKey = other.privateKey;
  otherJwk = { ...(await exportJWK(other.publicKey)), kid: "k2", alg: "RS256", use: "sig" };
});

async function token(opts: { kid?: string; signWith?: CryptoKey; iss?: string; aud?: string; sub?: string; life?: number; iat?: number } = {}) {
  const iat = opts.iat ?? Math.floor(NOW / 1000) - 10;
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256", kid: opts.kid ?? "k1" })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? TICK_TOKEN_AUDIENCE)
    .setSubject(opts.sub ?? SUB)
    .setIssuedAt(iat)
    .setExpirationTime(iat + (opts.life ?? 600))
    .sign(opts.signWith ?? key);
}

function source(...keysets: JWK[][]) {
  let call = 0;
  return vi.fn(async (): Promise<IssuerKeys> => ({ issuer: ISSUER, jwks: { keys: keysets[Math.min(call++, keysets.length - 1)] } }));
}

describe("JwksTokenAuthenticator", () => {
  it("returns the ServiceAccount username of a token the issuer signed for the tick audience", async () => {
    const auth = new JwksTokenAuthenticator(source([jwk]), TICK_TOKEN_AUDIENCE, () => NOW);
    expect(await auth.authenticate(await token())).toBe(SUB);
  });

  it("refuses a wrong issuer, a wrong audience, an expired token, a foreign signature and an over-long lifetime", async () => {
    const auth = new JwksTokenAuthenticator(source([jwk]), TICK_TOKEN_AUDIENCE, () => NOW);
    expect(await auth.authenticate(await token({ iss: "https://elsewhere" }))).toBeUndefined();
    expect(await auth.authenticate(await token({ aud: "https://kubernetes.default.svc" }))).toBeUndefined();
    expect(await auth.authenticate(await token({ iat: Math.floor(NOW / 1000) - 700 }))).toBeUndefined();
    expect(await auth.authenticate(await token({ signWith: otherKey }))).toBeUndefined();
    expect(await auth.authenticate(await token({ life: 86_400 }))).toBeUndefined();
    expect(await auth.authenticate("not-a-jwt")).toBeUndefined();
  });

  it("fails closed when the keys cannot be fetched", async () => {
    const failing = vi.fn(async (): Promise<IssuerKeys> => {
      throw new Error("forbidden");
    });
    const auth = new JwksTokenAuthenticator(failing, TICK_TOKEN_AUDIENCE, () => NOW);
    expect(await auth.authenticate(await token())).toBeUndefined();
  });

  it("refetches the keys once for an unknown key id (rotation), rate limited", async () => {
    let now = NOW;
    const keys = source([jwk], [jwk, otherJwk]);
    const auth = new JwksTokenAuthenticator(keys, TICK_TOKEN_AUDIENCE, () => now);
    expect(await auth.authenticate(await token())).toBe(SUB);
    expect(keys).toHaveBeenCalledTimes(1);

    // Rotated within the rate limit: not refetched yet, so refused.
    const rotated = await token({ kid: "k2", signWith: otherKey });
    expect(await auth.authenticate(rotated)).toBeUndefined();
    expect(keys).toHaveBeenCalledTimes(1);

    now += 31_000;
    expect(await auth.authenticate(await token({ kid: "k2", signWith: otherKey, iat: Math.floor(now / 1000) - 10 }))).toBe(SUB);
    expect(keys).toHaveBeenCalledTimes(2);
  });
});

describe("tickUsername", () => {
  it("is the source's eventsource-<name> ServiceAccount", () => {
    expect(tickUsername("agents", "nightly")).toBe("system:serviceaccount:agents:eventsource-nightly");
  });
});
