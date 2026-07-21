export interface DeviceFlowStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

/**
 * Starts GitHub's OAuth Device Flow: requests a device/user code pair that a
 * human will use at `verificationUri` to authorize this App as themselves.
 * Only the App's public `client_id` is needed — no client secret, no
 * redirect/callback URL, since the human confirms out-of-band in a browser.
 */
export async function startDeviceFlow(
  clientId: string,
  scope: string | undefined,
  githubBaseUrl = "https://github.com",
): Promise<DeviceFlowStart> {
  const body = new URLSearchParams({ client_id: clientId });
  if (scope) body.set("scope", scope);

  const res = await fetch(`${githubBaseUrl}/login/device/code`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(`Failed to start GitHub device flow: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as {
    device_code?: string;
    user_code?: string;
    verification_uri?: string;
    expires_in?: number;
    interval?: number;
  };
  if (!data.device_code || !data.user_code || !data.verification_uri || !data.expires_in || !data.interval) {
    throw new Error("GitHub device-code response was missing required fields");
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    expiresInSeconds: data.expires_in,
    pollIntervalSeconds: data.interval,
  };
}

export type DevicePollResult =
  | { status: "complete"; token: string; refreshToken: string | undefined; expiresAt: string; refreshExpiresAt: string | undefined }
  | { status: "pending" }
  | { status: "slow_down"; retryAfterSeconds: number }
  | { status: "expired" }
  | { status: "denied" };

interface AccessTokenErrorResponse {
  error?: string;
  interval?: number;
}

interface AccessTokenSuccessResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  expires_in?: number;
}

function toComplete(
  data: AccessTokenSuccessResponse,
  now: number,
): { status: "complete"; token: string; refreshToken: string | undefined; expiresAt: string; refreshExpiresAt: string | undefined } {
  if (!data.access_token || !data.expires_in) {
    throw new Error("GitHub access-token response was missing required fields");
  }
  return {
    status: "complete",
    token: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: new Date(now + data.expires_in * 1000).toISOString(),
    refreshExpiresAt:
      data.refresh_token_expires_in !== undefined
        ? new Date(now + data.refresh_token_expires_in * 1000).toISOString()
        : undefined,
  };
}

/**
 * Polls GitHub's token endpoint once for a pending device-flow authorization.
 * GitHub signals "still waiting" and similar non-fatal states via a 200
 * response with an `error` field rather than a non-2xx status, so those are
 * mapped to the discriminated union instead of being thrown.
 */
export async function pollDeviceFlow(
  clientId: string,
  deviceCode: string,
  githubBaseUrl = "https://github.com",
  now: number = Date.now(),
): Promise<DevicePollResult> {
  const res = await fetch(`${githubBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to poll GitHub device flow: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as AccessTokenErrorResponse & AccessTokenSuccessResponse;

  switch (data.error) {
    case undefined:
      return toComplete(data, now);
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      if (!data.interval) {
        throw new Error("GitHub slow_down response was missing the interval field");
      }
      return { status: "slow_down", retryAfterSeconds: data.interval };
    case "expired_token":
      return { status: "expired" };
    case "access_denied":
      return { status: "denied" };
    default:
      throw new Error(`Unexpected GitHub device-flow error: ${data.error}`);
  }
}

/**
 * Exchanges a still-valid refresh token for a new user access token.
 * GitHub Apps with device flow enabled issue expiring user tokens
 * (~8h) alongside a refresh token (~6mo); the refresh token itself
 * rotates on every use, so the new one must replace the old one.
 */
export async function refreshUserToken(
  clientId: string,
  refreshToken: string,
  githubBaseUrl = "https://github.com",
  now: number = Date.now(),
): Promise<{ token: string; refreshToken: string | undefined; expiresAt: string; refreshExpiresAt: string | undefined }> {
  const res = await fetch(`${githubBaseUrl}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to refresh GitHub user token: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as AccessTokenErrorResponse & AccessTokenSuccessResponse;
  if (data.error) {
    throw new Error(`Failed to refresh GitHub user token: ${data.error}`);
  }
  const { status: _status, ...token } = toComplete(data, now);
  return token;
}
