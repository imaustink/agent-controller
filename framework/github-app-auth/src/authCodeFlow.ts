/**
 * Builds the URL a browser-based caller (e.g. an Open WebUI user) is
 * redirected to in order to authorize this App via the standard OAuth
 * authorization-code flow — the browser-friendly alternative to device
 * flow's copy-a-code experience. `scope` is omitted entirely when
 * `undefined` rather than emitted as an empty `scope=` param.
 */
export function buildAuthorizeUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  scope: string | undefined,
  githubBaseUrl = "https://github.com",
): string {
  const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, state });
  if (scope) params.set("scope", scope);
  return `${githubBaseUrl}/login/oauth/authorize?${params.toString()}`;
}

interface AccessTokenErrorResponse {
  error?: string;
  error_description?: string;
}

interface AccessTokenSuccessResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  expires_in?: number;
}

/**
 * Exchanges the `code` GitHub redirected back with for a user access token.
 * GitHub signals failure for this endpoint (e.g. an already-used or expired
 * `code`) via a 200 response with an `error` field rather than a non-2xx
 * status, so that's checked explicitly in addition to `res.ok`.
 */
export async function exchangeCodeForToken(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
  githubBaseUrl = "https://github.com",
  now: number = Date.now(),
): Promise<{ token: string; refreshToken: string | undefined; expiresAt: string; refreshExpiresAt: string | undefined }> {
  const res = await fetch(`${githubBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to exchange GitHub authorization code: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as AccessTokenErrorResponse & AccessTokenSuccessResponse;
  if (data.error) {
    throw new Error(`Failed to exchange GitHub authorization code: ${data.error} ${data.error_description ?? ""}`.trim());
  }
  if (!data.access_token || !data.expires_in) {
    throw new Error("GitHub access-token response was missing required fields");
  }
  return {
    token: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now + data.expires_in * 1000).toISOString(),
    refreshExpiresAt:
      data.refresh_token_expires_in !== undefined
        ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
        : undefined,
  };
}
