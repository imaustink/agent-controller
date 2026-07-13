import { createSign } from "node:crypto";

/**
 * Minimal GitHub App authentication — no `@octokit/*` dependency, matching
 * this repo's "plain fetch, minimal deps" convention. We mint a short-lived
 * (~1h) *installation* access token that authenticates all git/`gh`
 * operations. The App's installation is what bounds which repositories this
 * tool can touch.
 */

export type FetchLike = typeof fetch;

export interface InstallationToken {
  token: string;
  /** ISO-8601 expiry from GitHub (installation tokens live ~1h). */
  expiresAt: string;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Builds an RS256-signed JWT for the App (used only to call the
 * `/app/*` endpoints that mint installation tokens). `iat` is backdated 60s
 * to tolerate clock skew; `exp` is 9 minutes out (GitHub's max is 10).
 */
export function createAppJwt(appId: string, privateKeyPem: string, nowSec: number = Math.floor(Date.now() / 1000)): string {
  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iat: nowSec - 60, exp: nowSec + 9 * 60, iss: appId };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(privateKeyPem).toString("base64url");
  return `${signingInput}.${signature}`;
}

export class GitHubAppError extends Error {}

interface GitHubClientOptions {
  apiUrl: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

async function githubRequest(
  url: string,
  auth: string,
  opts: GitHubClientOptions,
  method: "GET" | "POST" = "GET",
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const res = await fetchImpl(url, {
      method,
      headers: {
        Authorization: auth,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "copilot-swe",
      },
      redirect: "error",
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GitHubAppError(`GitHub API ${method} ${new URL(url).pathname} failed (${res.status}): ${text.slice(0, 300)}`);
    }
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves the installation id to mint a token for. Prefers an explicitly
 * configured id; otherwise, if a target repo is known, looks up that repo's
 * installation; otherwise falls back to the App's first installation.
 */
export async function resolveInstallationId(
  jwt: string,
  opts: GitHubClientOptions & { configuredId?: string; repo?: string },
): Promise<string> {
  if (opts.configuredId) return opts.configuredId;

  if (opts.repo && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(opts.repo)) {
    const body = (await githubRequest(`${opts.apiUrl}/repos/${opts.repo}/installation`, `Bearer ${jwt}`, opts)) as {
      id?: number;
    };
    if (typeof body.id === "number") return String(body.id);
  }

  const installs = (await githubRequest(`${opts.apiUrl}/app/installations`, `Bearer ${jwt}`, opts)) as Array<{ id?: number }>;
  const first = Array.isArray(installs) ? installs[0] : undefined;
  if (first && typeof first.id === "number") return String(first.id);

  throw new GitHubAppError("could not resolve a GitHub App installation id (none configured, no repo, no installations found)");
}

/** Mints a short-lived installation access token for the given installation id. */
export async function mintInstallationToken(jwt: string, installationId: string, opts: GitHubClientOptions): Promise<InstallationToken> {
  const body = (await githubRequest(
    `${opts.apiUrl}/app/installations/${installationId}/access_tokens`,
    `Bearer ${jwt}`,
    opts,
    "POST",
  )) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new GitHubAppError("GitHub did not return an installation token");
  }
  return { token: body.token, expiresAt: body.expires_at ?? "" };
}
