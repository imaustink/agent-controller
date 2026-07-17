import { createSign } from "node:crypto";

export interface GithubAppCredentials {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

function base64url(input: Buffer | string): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Signs a GitHub App JWT (RS256), per GitHub's App-authentication spec. `iat`
 * is backdated 60s to tolerate clock drift between this container and
 * GitHub's servers; `exp` sits at GitHub's 10-minute maximum. This JWT
 * authenticates as the App itself — it is only ever used to mint a scoped
 * installation token below, never passed to git/gh directly.
 */
export function signAppJwt(appId: string, privateKeyPem: string, now: number): string {
  const nowSeconds = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ iat: nowSeconds - 60, exp: nowSeconds + 600, iss: appId }));
  const signingInput = `${header}.${payload}`;
  const signature = base64url(createSign("RSA-SHA256").update(signingInput).sign(privateKeyPem));
  return `${signingInput}.${signature}`;
}

/**
 * Exchanges an App JWT for a short-lived (~1h) installation access token,
 * scoped to exactly the repos/permissions the installation grants — the
 * per-repo governance and short-lived-credential properties a static PAT
 * doesn't have.
 */
export async function mintInstallationToken(
  creds: GithubAppCredentials,
  apiBaseUrl: string,
  now: number,
): Promise<InstallationToken> {
  const jwt = signAppJwt(creds.appId, creds.privateKey, now);
  const res = await fetch(`${apiBaseUrl}/app/installations/${creds.installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to mint GitHub App installation token: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { token?: string; expires_at?: string };
  if (!body.token) {
    throw new Error("GitHub App installation-token response had no token field");
  }
  return { token: body.token, expiresAt: body.expires_at ?? "" };
}

export interface GithubAuthConfig {
  githubToken: string;
  githubAppId: string;
  githubAppPrivateKey: string;
  githubAppInstallationId: string;
  githubApiUrl: string;
}

/**
 * Resolves the token used for all git/gh operations. Prefers a GitHub App
 * installation token (short-lived, scoped to one installation) when all
 * three App env vars are set; otherwise falls back to the static
 * fine-grained PAT (`GITHUB_TOKEN`) for backwards compatibility. A partial
 * App configuration (1 or 2 of the 3 fields) is rejected rather than
 * silently falling back, since that's almost certainly a misconfiguration.
 */
export async function resolveGithubToken(config: GithubAuthConfig, now: number = Date.now()): Promise<string> {
  const { githubAppId, githubAppPrivateKey, githubAppInstallationId } = config;
  const appFieldsSet = [githubAppId, githubAppPrivateKey, githubAppInstallationId].filter(Boolean).length;

  if (appFieldsSet > 0 && appFieldsSet < 3) {
    throw new Error(
      "Partial GitHub App configuration: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID must all be set together",
    );
  }

  if (appFieldsSet === 3) {
    const { token } = await mintInstallationToken(
      { appId: githubAppId, privateKey: githubAppPrivateKey, installationId: githubAppInstallationId },
      config.githubApiUrl,
      now,
    );
    return token;
  }

  if (config.githubToken) return config.githubToken;

  throw new Error(
    "GitHub credentials are required: set either GITHUB_TOKEN (fine-grained PAT) or all of " +
      "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID (GitHub App) — inject via secretEnv/secretKeyRef on the Agent CR",
  );
}
