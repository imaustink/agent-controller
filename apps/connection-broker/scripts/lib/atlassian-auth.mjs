/**
 * The Atlassian 3LO dance, shared by the verify and end-to-end scripts.
 *
 * Extracted rather than duplicated because the two scripts must authenticate
 * IDENTICALLY — the whole point of the end-to-end run is that it exercises the
 * same credential the verify run proved works, so a drift between two copies
 * of this would make a failure impossible to attribute.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const REDIRECT = "http://localhost:9099/callback";
export const GATEWAY = "https://api.atlassian.com";

/** Granular scopes. The app was migrated off classic, whose v1 endpoints are gone. */
export const DEFAULT_SCOPES = [
  "read:page:confluence",
  "read:space:confluence",
  "read:content-details:confluence",
  "offline_access",
].join(" ");

/**
 * Finds the env file.
 *
 * Checked against the MAIN checkout as well as the cwd, because .env is
 * gitignored and a git worktree is a separate copy of the repo — so running
 * from a worktree finds nothing, which is a confusing way to learn that your
 * credentials live somewhere else.
 */
export function findEnvFile(explicit) {
  const candidates = [explicit].filter(Boolean);
  if (!explicit) {
    candidates.push("tools/recipe-scraper/.env");
    try {
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
  process.exit(1);
}

/** Reads the env file without echoing any value. */
export function loadEnv(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Waits for the OAuth redirect and hands back the code. */
function awaitCode(expectedState, timeoutMs) {
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

/**
 * Runs the full authorization-code flow and returns an access token.
 *
 * Opens the browser rather than printing a URL to be copied: this blocks on a
 * human approving, so when stdout is captured the URL goes to a log file and
 * the script looks hung rather than waiting.
 */
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

  const authorizeUrl = authorize.toString();
  console.log("\nOpening your browser to approve access…");
  // A temp file rather than the repo: the URL carries the OAuth client_id,
  // which is not secret but has no business being committed by accident.
  const urlFile = join(tmpdir(), "atlassian-authorize-url.txt");
  writeFileSync(urlFile, `${authorizeUrl}\n`);
  console.log(`(if nothing opens, the URL is in ${urlFile})\n`);

  try {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFileSync(opener, [authorizeUrl], { stdio: "ignore" });
  } catch {
    console.log(`Could not open a browser automatically — open the URL in ${urlFile}`);
  }

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
