/**
 * The Google OAuth dance for the Drive harness.
 *
 * Same loopback as Atlassian (see oauth-loopback.mjs); what differs is the
 * endpoints, the form-encoded token exchange Google wants instead of JSON, and
 * `access_type=offline` + `prompt=consent`, without which a second run gets an
 * access token and no refresh token and the harness cannot tell you why.
 */
import { randomBytes } from "node:crypto";
import { awaitCode, openForApproval, REDIRECT } from "./oauth-loopback.mjs";

export { REDIRECT };

/**
 * Read-only, and deliberately the NARROW read-only scope.
 *
 * `drive.readonly` covers every file the user can see, which is what the
 * corpus walk and the per-user probe both need — the probe's entire job is to
 * ask what THIS user may open (ADR 0040), so a scope narrower than the user's
 * own view would make it answer the wrong question.
 */
export const DEFAULT_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"].join(" ");

/** Runs the full authorization-code flow and returns an access token. */
export async function getAccessToken({ env, scopes = DEFAULT_SCOPES, timeoutMs = 5 * 60 * 1000 }) {
  const clientId = env.GOOGLE_CLIENT_ID;
  const clientSecret = env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not found in the env file");
  }

  const state = randomBytes(16).toString("hex");
  const authorize = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("scope", scopes);
  authorize.searchParams.set("redirect_uri", REDIRECT);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("access_type", "offline");
  authorize.searchParams.set("prompt", "consent");

  openForApproval(authorize.toString(), "google");
  const code = await awaitCode(state, timeoutMs);

  // Form-encoded, not JSON: Google's token endpoint rejects a JSON body with a
  // 400 whose message does not mention the encoding.
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: REDIRECT,
    }).toString(),
  });
  if (!response.ok) {
    // Google puts the actionable part (redirect_uri_mismatch, invalid_client)
    // in the body, and a bare status sends you to check the wrong thing.
    const detail = await response.text().catch(() => "");
    throw new Error(`token exchange failed: ${response.status} ${detail.slice(0, 200)}`);
  }

  const tokens = await response.json();
  console.log("granted scope:", tokens.scope || "(none)");
  return tokens.access_token;
}
