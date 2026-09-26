/**
 * The Atlassian 3LO dance, shared by the verify and end-to-end scripts.
 *
 * Extracted rather than duplicated because the two scripts must authenticate
 * IDENTICALLY — the whole point of the end-to-end run is that it exercises the
 * same credential the verify run proved works, so a drift between two copies
 * of this would make a failure impossible to attribute.
 */
import { randomBytes } from "node:crypto";
import { awaitCode, openForApproval, REDIRECT } from "./oauth-loopback.mjs";

export { REDIRECT };
export const GATEWAY = "https://api.atlassian.com";

/** Granular scopes. The app was migrated off classic, whose v1 endpoints are gone. */
export const DEFAULT_SCOPES = [
  "read:page:confluence",
  "read:space:confluence",
  "read:content-details:confluence",
  "offline_access",
].join(" ");

/** Runs the full authorization-code flow and returns an access token. */
export async function getAccessToken({ env, scopes = DEFAULT_SCOPES, timeoutMs = 5 * 60 * 1000 }) {
  const clientId = env.ATLASSIAN_CLIENT_ID;
  const clientSecret = env.ATLASSIAN_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET not found in the env file");
  }

  const state = randomBytes(16).toString("hex");
  const authorize = new URL("https://auth.atlassian.com/authorize");
  authorize.searchParams.set("audience", "api.atlassian.com");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("scope", scopes);
  authorize.searchParams.set("redirect_uri", REDIRECT);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("prompt", "consent");

  openForApproval(authorize.toString(), "atlassian");
  const code = await awaitCode(state, timeoutMs);

  const response = await fetch("https://auth.atlassian.com/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT,
    }),
  });
  if (!response.ok) throw new Error(`token exchange failed: ${response.status}`);

  const tokens = await response.json();
  console.log("granted scope:", tokens.scope || "(none)");
  return tokens.access_token;
}
