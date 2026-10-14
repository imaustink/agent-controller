/**
 * Who may tick a cron EventSource (docs/event-triggers.md §8).
 *
 * core-controller gives each cron source its own ServiceAccount
 * (`eventsource-<name>`, the CronJob's name) and the tick pod presents a
 * projected token for it, audience {@link TICK_TOKEN_AUDIENCE}. The gateway
 * asks the API server to review that token: no shared secret to generate,
 * store or rotate, and a source's identity can only tick that one source.
 */

import { createHash } from "node:crypto";

/**
 * Review outcomes are cached briefly: a tick's token is reused for its whole
 * (short) pod life, and a burst of the same bad token must not become a burst
 * of API calls. Short enough that a deleted ServiceAccount stops working fast.
 */
const REVIEW_CACHE_TTL_MS = 30_000;
const REVIEW_CACHE_MAX = 256;

/** Audience the tick's projected token is minted for; anything else is refused. */
export const TICK_TOKEN_AUDIENCE = "integration-gateway.events";

/** The ServiceAccount (and CronJob) core-controller creates for a cron source. */
export function tickServiceAccountName(source: string): string {
  return `eventsource-${source}`;
}

/** Answers "whose token is this?" -- the authenticated username, or undefined. */
export interface TokenAuthenticator {
  authenticate(token: string): Promise<string | undefined>;
}

/** The slice of `AuthenticationV1Api` used (verb: create on tokenreviews). */
export interface TokenReviewApi {
  createTokenReview(request: {
    body: { apiVersion: string; kind: string; spec: { token: string; audiences: string[] } };
  }): Promise<{ status?: { authenticated?: boolean; audiences?: string[]; user?: { username?: string } } }>;
}

/**
 * {@link TokenAuthenticator} backed by the TokenReview API. A bound projected
 * token also stops reviewing once its pod is gone, so a token lifted from a
 * finished tick is useless. Any API error is "not authenticated" (fail closed).
 */
export class KubeTokenAuthenticator implements TokenAuthenticator {
  /** sha256(token) -> outcome, so a replayed token (good or bad) is one review per TTL. */
  private readonly cache = new Map<string, { username: string | undefined; expiresAt: number }>();

  constructor(
    private readonly api: TokenReviewApi,
    private readonly audience: string = TICK_TOKEN_AUDIENCE,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async authenticate(token: string): Promise<string | undefined> {
    const key = createHash("sha256").update(token).digest("hex");
    const hit = this.cache.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.username;
    const username = await this.review(token);
    if (this.cache.size >= REVIEW_CACHE_MAX) this.cache.clear();
    this.cache.set(key, { username, expiresAt: this.now() + REVIEW_CACHE_TTL_MS });
    return username;
  }

  private async review(token: string): Promise<string | undefined> {
    try {
      const review = await this.api.createTokenReview({
        body: {
          apiVersion: "authentication.k8s.io/v1",
          kind: "TokenReview",
          spec: { token, audiences: [this.audience] },
        },
      });
      const status = review.status;
      // An authenticator that ignores audiences answers without echoing them;
      // that token was never shown to be minted for us.
      if (!status?.authenticated || !status.audiences?.includes(this.audience)) return undefined;
      return status.user?.username || undefined;
    } catch (error) {
      console.error(`TokenReview failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}

/** The username a source's tick token must authenticate as. */
export function tickUsername(namespace: string, source: string): string {
  return `system:serviceaccount:${namespace}:${tickServiceAccountName(source)}`;
}
