#!/usr/bin/env node
/**
 * Probes a real Confluence tenant and reports what its API actually returns.
 *
 * Why this exists: every Confluence shape the driver depends on — `_links.webui`,
 * `_links.base`, the read-restriction nesting, whether `space.key` comes back on
 * a content GET — is currently a guess. A fetch-mocked test cannot discover that
 * a guess is wrong, because the mock answers whatever it is asked. This script
 * asks the tenant.
 *
 * It deliberately does NOT use the driver. Running the driver here would
 * conflate two questions — "what does Confluence return" and "does our code
 * handle it" — and only the first one is unknown.
 *
 * It prints SHAPES, never content and never credentials: key names, presence,
 * and a couple of short values that are structural (a space key, a version
 * number). Nothing it writes should be sensitive, but read the output before
 * pasting it anywhere.
 *
 *   node apps/connection-broker/scripts/verify-confluence.mjs <SPACE_KEY> [envfile]
 *
 * It also prints the site's cloudId, which is worth recording: a site on a
 * CUSTOM DOMAIN (wiki.at.bitovi.com) cannot be matched against the canonical
 * *.atlassian.net address this endpoint reports, so the Connection should carry
 * the cloudId rather than rely on discovery.
 *
 * Requires ATLASSIAN_CLIENT_ID and ATLASSIAN_CLIENT_SECRET in the env file
 * (default: tools/recipe-scraper/.env), and http://localhost:9099/callback
 * registered as a callback URL on the Atlassian app.
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

const REDIRECT = "http://localhost:9099/callback";
const GATEWAY = "https://api.atlassian.com";
const SCOPES = "read:confluence-content.all offline_access";

const spaceKey = process.argv[2];
const envPath = process.argv[3] ?? "tools/recipe-scraper/.env";
if (!spaceKey) {
  console.error("usage: verify-confluence.mjs <SPACE_KEY> [envfile]");
  process.exit(1);
}

/** Reads the env file without echoing any value. */
function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

const env = loadEnv(envPath);
const clientId = env.ATLASSIAN_CLIENT_ID;
const clientSecret = env.ATLASSIAN_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(`ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET not found in ${envPath}`);
  process.exit(1);
}

/** Waits for the OAuth redirect and hands back the code. */
function awaitCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://localhost:9099");
      if (url.pathname !== "/callback") return res.writeHead(404).end();

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<p>Linked. You can close this tab.</p>");
      server.close();

      if (state !== expectedState) return reject(new Error("state mismatch"));
      if (!code) return reject(new Error(`no code: ${url.searchParams.get("error") ?? "unknown"}`));
      resolve(code);
    });
    server.listen(9099);
  });
}

const state = randomBytes(16).toString("hex");
const authorize = new URL("https://auth.atlassian.com/authorize");
authorize.searchParams.set("audience", "api.atlassian.com");
authorize.searchParams.set("client_id", clientId);
authorize.searchParams.set("scope", SCOPES);
authorize.searchParams.set("redirect_uri", REDIRECT);
authorize.searchParams.set("state", state);
authorize.searchParams.set("response_type", "code");
authorize.searchParams.set("prompt", "consent");

console.log("\nOpen this URL, approve, and come back:\n");
console.log(authorize.toString());
console.log("");

const code = await awaitCode(state);

const tokenResponse = await fetch("https://auth.atlassian.com/oauth/token", {
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
if (!tokenResponse.ok) {
  console.error(`token exchange failed: ${tokenResponse.status}`);
  process.exit(1);
}
const tokens = await tokenResponse.json();
const token = tokens.access_token;

// Report the SHAPE of the token response, never its values.
console.log("token response fields:", Object.keys(tokens).sort().join(", "));
console.log("  expires_in:", tokens.expires_in, "· refresh_token present:", Boolean(tokens.refresh_token));

const call = async (url) => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${response.status} ${url.replace(/\/\/[^/]+/, "//…")}`);
  return response.json();
};

const resources = await call(`${GATEWAY}/oauth/token/accessible-resources`);
console.log("\naccessible resources:");
for (const r of resources) console.log(`  ${r.id}  ${r.url}`);

const cloudId = resources[0]?.id;
if (!cloudId) {
  console.error("no accessible resource — the app may not be installed on a site");
  process.exit(1);
}
if (resources.length > 1) {
  console.log(`  note: ${resources.length} sites reachable; using the first. Set cloudId explicitly in the Connection.`);
}
console.log("  cloudId to configure:", cloudId);
const api = `${GATEWAY}/ex/confluence/${cloudId}`;

const listUrl =
  `${api}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}` +
  `&expand=version,space,restrictions.read.restrictions.user,restrictions.read.restrictions.group` +
  `&limit=3`;
const list = await call(listUrl);
console.log(`\nlist: ${list.results?.length ?? 0} result(s), top-level keys:`, Object.keys(list).sort().join(", "));

const first = list.results?.[0];
if (!first) {
  console.error(`\nno content in space ${spaceKey} — wrong key, or no read access`);
  process.exit(1);
}
console.log("  result keys:", Object.keys(first).sort().join(", "));
console.log("  _links keys:", Object.keys(first._links ?? {}).sort().join(", "));
console.log("  _links.base:", first._links?.base ?? "(absent)");
console.log("  _links.webui:", first._links?.webui ?? "(absent)");
console.log("  space.key:", first.space?.key ?? "(absent)");
console.log("  version.number:", first.version?.number ?? "(absent)");
console.log("  restrictions present:", Boolean(first.restrictions));
if (first.restrictions) {
  console.log("  restriction path:", JSON.stringify(first.restrictions).slice(0, 300));
}

const detail = await call(
  `${api}/rest/api/content/${first.id}?expand=body.storage,version,space,` +
    `restrictions.read.restrictions.user,restrictions.read.restrictions.group`,
);
console.log("\ncontent GET keys:", Object.keys(detail).sort().join(", "));
console.log("  space.key:", detail.space?.key ?? "(absent — scope check would fail closed)");
console.log("  body.storage present:", Boolean(detail.body?.storage?.value));
console.log("  storage length:", detail.body?.storage?.value?.length ?? 0);

const probe = await call(`${api}/rest/api/content/${first.id}?expand=version,space`);
console.log("\nprobe-shaped GET keys:", Object.keys(probe).sort().join(", "));
console.log("  space.key:", probe.space?.key ?? "(absent — scope check would fail closed)");
console.log("  title present:", Boolean(probe.title));
console.log("  _links.webui:", probe._links?.webui ?? "(absent)");

console.log("\nDone. Nothing above contains a credential.");
