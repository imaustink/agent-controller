/**
 * Who may tick a cron EventSource (docs/event-triggers.md §8).
 *
 * core-controller gives each cron source its own ServiceAccount
 * (`eventsource-<name>`, the CronJob's name) and the tick pod presents a
 * projected token for it, audience {@link TICK_TOKEN_AUDIENCE}. The gateway
 * verifies that token itself, against the cluster's ServiceAccount issuer
 * keys: no shared secret to generate, store or rotate, and a source's identity
 * can only tick that one source.
 *
 * Verified locally rather than by TokenReview, because TokenReview needs a
 * ClusterRole, and a chart that ships a ClusterRole can only be deployed by
 * something allowed to write ClusterRoles. The issuer keys are readable by
 * every ServiceAccount by default (the `system:service-account-issuer-discovery`
 * binding), so this needs no RBAC at all. What it gives up: TokenReview also
 * refuses a token whose ServiceAccount or pod has since been deleted. A tick
 * token lives {@link TICK_TOKEN_MAX_LIFETIME_SECONDS} at most, which bounds that
 * window.
 */

import https from "node:https";
import type * as k8s from "@kubernetes/client-node";
import { createLocalJWKSet, errors, jwtVerify, type JSONWebKeySet, type JWTVerifyGetKey } from "jose";

/** Audience the tick's projected token is minted for; anything else is refused. */
export const TICK_TOKEN_AUDIENCE = "integration-gateway.events";

/**
 * Longest life a tick token may claim (core-controller projects 600s). A
 * token claiming more was not minted for a tick, and without TokenReview a
 * long-lived token would outlive the ServiceAccount it names.
 */
export const TICK_TOKEN_MAX_LIFETIME_SECONDS = 3600;

/**
 * Least time between key refetches. Keys are refetched when a token names a
 * key we do not hold (the API server rotated its signing key), and a stream of
 * junk tokens must not become a stream of API calls.
 */
const KEY_REFRESH_MIN_INTERVAL_MS = 30_000;

/** The algorithms the API server signs ServiceAccount tokens with. */
const SIGNING_ALGORITHMS = ["RS256", "ES256"];

/** The ServiceAccount (and CronJob) core-controller creates for a cron source. */
export function tickServiceAccountName(source: string): string {
  return `eventsource-${source}`;
}

/** Answers "whose token is this?" -- the authenticated username, or undefined. */
export interface TokenAuthenticator {
  authenticate(token: string): Promise<string | undefined>;
}

/** The cluster's ServiceAccount token issuer and its current signing keys. */
export interface IssuerKeys {
  issuer: string;
  jwks: JSONWebKeySet;
}

export type IssuerKeySource = () => Promise<IssuerKeys>;

/**
 * Reads the issuer (`/.well-known/openid-configuration`) and its keys
 * (`/openid/v1/jwks`) from the API server, as the gateway's own ServiceAccount.
 * The keys come from the API server even when the discovery document points
 * `jwks_uri` elsewhere (EKS publishes a public URL), so the gateway needs no
 * egress beyond the API server it already talks to.
 */
export function kubeIssuerKeySource(kubeConfig: k8s.KubeConfig): IssuerKeySource {
  const get = async (path: string): Promise<unknown> => {
    const server = kubeConfig.getCurrentCluster()?.server;
    if (!server) throw new Error("no current cluster in the kubeconfig");
    const options: https.RequestOptions = {};
    await kubeConfig.applyToHTTPSOptions(options);
    return await new Promise((resolve, reject) => {
      const req = https.get(new URL(path, server), options, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) return reject(new Error(`GET ${path}: HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      });
      req.on("error", reject);
      req.setTimeout(10_000, () => req.destroy(new Error(`GET ${path}: timed out`)));
    });
  };
  return async () => {
    const discovery = (await get("/.well-known/openid-configuration")) as { issuer?: unknown };
    if (typeof discovery.issuer !== "string" || !discovery.issuer) throw new Error("issuer discovery has no issuer");
    const jwks = (await get("/openid/v1/jwks")) as JSONWebKeySet;
    if (!Array.isArray(jwks?.keys)) throw new Error("issuer keyset has no keys");
    return { issuer: discovery.issuer, jwks };
  };
}

/**
 * {@link TokenAuthenticator} that verifies a projected ServiceAccount token
 * against the cluster issuer's keys: signature, issuer, audience, expiry and a
 * bounded lifetime. Any failure, including not being able to fetch the keys,
 * is "not authenticated" (fail closed).
 */
export class JwksTokenAuthenticator implements TokenAuthenticator {
  private keys: { issuer: string; getKey: JWTVerifyGetKey } | undefined;
  private lastFetchAt = Number.NEGATIVE_INFINITY;
  private inflight: Promise<void> | undefined;

  constructor(
    private readonly source: IssuerKeySource,
    private readonly audience: string = TICK_TOKEN_AUDIENCE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async authenticate(token: string): Promise<string | undefined> {
    if (!this.keys) await this.refresh();
    const first = await this.verify(token);
    if (first !== "unknown-key") return first;
    // A key we do not hold: the API server may have rotated. One refetch
    // (rate limited), then one more try.
    await this.refresh();
    const second = await this.verify(token);
    return second === "unknown-key" ? undefined : second;
  }

  private async verify(token: string): Promise<string | undefined | "unknown-key"> {
    if (!this.keys) return undefined;
    try {
      const { payload } = await jwtVerify(token, this.keys.getKey, {
        issuer: this.keys.issuer,
        audience: this.audience,
        algorithms: SIGNING_ALGORITHMS,
        requiredClaims: ["exp", "iat", "sub"],
        currentDate: new Date(this.now()),
      });
      if ((payload.exp ?? 0) - (payload.iat ?? 0) > TICK_TOKEN_MAX_LIFETIME_SECONDS) return undefined;
      return payload.sub || undefined;
    } catch (error) {
      if (error instanceof errors.JWKSNoMatchingKey) return "unknown-key";
      return undefined;
    }
  }

  private async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (this.now() - this.lastFetchAt < KEY_REFRESH_MIN_INTERVAL_MS) return;
    this.lastFetchAt = this.now();
    this.inflight = (async () => {
      try {
        const { issuer, jwks } = await this.source();
        this.keys = { issuer, getKey: createLocalJWKSet(jwks) };
      } catch (error) {
        console.error(`Fetching the ServiceAccount issuer keys failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}

/** The username a source's tick token must authenticate as. */
export function tickUsername(namespace: string, source: string): string {
  return `system:serviceaccount:${namespace}:${tickServiceAccountName(source)}`;
}
