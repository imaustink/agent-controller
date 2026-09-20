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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REDIRECT = "http://localhost:9099/callback";
const GATEWAY = "https://api.atlassian.com";
/**
 * GRANULAR scopes, not the classic `read:confluence-content.all`.
 *
 * A classic scope on a granular app is granted — it comes back in the token's
 * scope string — and then authorizes nothing, which surfaces as
 * `401 "scope does not match"` on every endpoint including v1. Classic and
 * granular cannot be mixed, and newly created apps are granular.
 *
 * Override with ATLASSIAN_SCOPES in the env file to iterate without editing
 * this script; each scope must also be enabled on the app in the developer
 * console, or the authorize request itself is rejected.
 */
const DEFAULT_SCOPES = [
  "read:page:confluence",
  "read:space:confluence",
  "read:content-details:confluence",
  "offline_access",
].join(" ");

const spaceKey = process.argv[2];
if (!spaceKey) {
  console.error("usage: verify-confluence.mjs <SPACE_KEY> [envfile]");
  process.exit(1);
}
const envPath = findEnvFile(process.argv[3]);
console.log(`reading credentials from ${envPath} (values are never printed)`);

/**
 * Finds the env file.
 *
 * Checked against the MAIN checkout as well as the cwd, because .env is
 * gitignored and a git worktree is a separate copy of the repo — so running
 * this from a worktree finds nothing, which is a confusing way to learn that
 * your credentials live somewhere else.
 */
function findEnvFile(explicit) {
  const candidates = [explicit].filter(Boolean);
  if (!explicit) {
    candidates.push("tools/recipe-scraper/.env");
    try {
      // The parent of the shared git dir is the main checkout.
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
      }).trim();
      candidates.push(join(common, "..", "tools/recipe-scraper/.env"));
    } catch {
      // Not a git checkout; the cwd-relative candidate is all there is.
    }
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  console.error("Could not find an env file with the Atlassian credentials. Looked in:");
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error("\nPass the path explicitly:");
  console.error("  node apps/connection-broker/scripts/verify-confluence.mjs SNC /path/to/.env");
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
const SCOPES = env.ATLASSIAN_SCOPES || DEFAULT_SCOPES;
console.log("requesting scopes:", SCOPES);
const clientId = env.ATLASSIAN_CLIENT_ID;
const clientSecret = env.ATLASSIAN_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error(`ATLASSIAN_CLIENT_ID / ATLASSIAN_CLIENT_SECRET not found in ${envPath}`);
  process.exit(1);
}

/** Waits for the OAuth redirect and hands back the code. */
function awaitCode(expectedState, timeoutMs = 5 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    // Bounded: an unbounded wait on a human is indistinguishable from a hang,
    // and leaves port 9099 held by a process nobody remembers starting.
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("timed out waiting for the browser redirect"));
    }, timeoutMs);
    const done = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    resolve = done(resolve);
    reject = done(reject);

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

// Open it rather than printing it to be copied. This script blocks on a human
// approving in a browser, so when it is run in a way that captures stdout the
// URL goes to a log file and the script looks hung rather than waiting.
const authorizeUrl = authorize.toString();
console.log("\nOpening your browser to approve access…");
// Written to a temp file rather than into the repo: the URL carries the OAuth
// client_id, which is not secret but has no business being committed by
// accident, and nothing under scripts/ is gitignored.
const urlFile = join(tmpdir(), "atlassian-authorize-url.txt");
writeFileSync(urlFile, `${authorizeUrl}\n`);
console.log(`(if nothing opens, the URL is in ${urlFile})\n`);

try {
  const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  execFileSync(opener, [authorizeUrl], { stdio: "ignore" });
} catch {
  console.log(`Could not open a browser automatically — open the URL in ${urlFile}`);
}

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

// Report the SHAPE of the token response, never its values. The GRANTED scope
// is the exception and is printed in full: it is the single most useful thing
// when a valid token gets a 401, and it is not a secret.
console.log("token response fields:", Object.keys(tokens).sort().join(", "));
console.log("  expires_in:", tokens.expires_in, "· refresh_token present:", Boolean(tokens.refresh_token));
console.log("  granted scope:", tokens.scope || "(none — the app has no API permissions added)");
if (!String(tokens.scope ?? "").includes("confluence")) {
  console.log("\n  !! No Confluence scope was granted. The OAuth app needs the Confluence API");
  console.log("     added under Permissions, with its read scopes enabled, before any");
  console.log("     content call can succeed — a token without them authenticates but");
  console.log("     authorizes nothing.");
}

const call = async (url) => {
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const err = new Error(`${response.status} ${url.replace(/^https:\/\/[^/]+/, "")}`);
    err.status = response.status;
    err.detail = detail.slice(0, 300);
    throw err;
  }
  return response.json();
};

/** Tries a call and reports rather than throwing, so one dead endpoint does not end the run. */
const tryCall = async (label, url) => {
  try {
    const body = await call(url);
    console.log(`  ${label}: OK`);
    return body;
  } catch (err) {
    console.log(`  ${label}: ${err.status ?? "error"} ${err.detail ?? err.message}`);
    return undefined;
  }
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

// Confluence Cloud has two generations of REST API and Atlassian is retiring
// the first. Which one this tenant answers decides what the driver must call,
// so both are tried rather than assumed.
console.log("\nwhich content API answers:");
const v1 = await tryCall(
  "v1 /rest/api/content",
  `${api}/rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&limit=1`,
);
const v2Spaces = await tryCall("v2 /api/v2/spaces", `${api}/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`);
if (v2Spaces?.results?.[0]?.id) {
  await tryCall("v2 /api/v2/spaces/{id}/pages", `${api}/api/v2/spaces/${v2Spaces.results[0].id}/pages?limit=1`);
  console.log("  v2 space id:", v2Spaces.results[0].id, "· key:", v2Spaces.results[0].key);
}

if (!v1) {
  console.log("\nStopping: the v1 content API did not answer, so the shapes below cannot be read.");
  console.log("Fix the scopes (or move the driver to v2) and run again.");
  process.exit(1);
}

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
