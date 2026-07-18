import type { Identity, IdentityResolver } from "./types.js";

/**
 * DEV/TEST ONLY identity resolver: looks up a pre-shared bearer token in a
 * static map. There is no cryptographic verification here.
 *
 * The real IdP/OIDC integration (verify a signed JWT, map its claims to
 * roles) is an explicitly open question. This class exists so the rest of the
 * gateway can be built and tested against the {@link IdentityResolver} port
 * now, without inventing ad-hoc, unverified "JWT decoding" that would be a
 * broken-authentication vulnerability if it ever reached production.
 *
 * DO NOT use this resolver outside local development/tests.
 */
export class StaticIdentityResolver implements IdentityResolver {
  constructor(private readonly tokens: ReadonlyMap<string, Identity>) {}

  async resolve(authToken: string): Promise<Identity | undefined> {
    return this.tokens.get(authToken);
  }
}

/**
 * Parses the `GATEWAY_STATIC_IDENTITIES` env var: JSON object of
 * `{ "<token>": { "subject": "...", "roles": ["..."] } }`. Returns an
 * empty map (fail closed) on missing/invalid input.
 */
export function loadStaticIdentitiesFromEnv(raw: string | undefined): ReadonlyMap<string, Identity> {
  if (!raw) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return new Map();
    const map = new Map<string, Identity>();
    for (const [token, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (
        typeof value === "object" &&
        value !== null &&
        "subject" in value &&
        "roles" in value &&
        typeof (value as { subject: unknown }).subject === "string" &&
        Array.isArray((value as { roles: unknown }).roles)
      ) {
        const roles = (value as { roles: unknown[] }).roles.filter((role): role is string => typeof role === "string");
        map.set(token, { subject: (value as { subject: string }).subject, roles });
      }
    }
    return map;
  } catch {
    return new Map();
  }
}
