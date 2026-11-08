/**
 * The provider-agnostic half of an authorization-code flow: hold a loopback
 * port, open a browser, hand back the code.
 *
 * Extracted from atlassian-auth so the Google flow does not grow a second copy.
 * Only the URLs and the token-exchange body differ between providers, and those
 * stay with each provider; everything here is the same dance either way.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const REDIRECT_PORT = 9099;
export const REDIRECT = `http://localhost:${REDIRECT_PORT}/callback`;

/** Waits for the OAuth redirect and hands back the code. */
export function awaitCode(expectedState, timeoutMs) {
  return new Promise((resolve, reject) => {
    // Bounded: an unbounded wait on a human is indistinguishable from a hang,
    // and leaves the port held by a process nobody remembers starting.
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
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
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
    server.listen(REDIRECT_PORT);
  });
}

/**
 * Opens the browser rather than printing a URL to be copied.
 *
 * This blocks on a human approving, so when stdout is captured the URL goes to
 * a log file and the script looks hung rather than waiting.
 */
export function openForApproval(authorizeUrl, label) {
  console.log("\nOpening your browser to approve access…");
  // A temp file rather than the repo: the URL carries the OAuth client_id,
  // which is not secret but has no business being committed by accident.
  const urlFile = join(tmpdir(), `${label}-authorize-url.txt`);
  writeFileSync(urlFile, `${authorizeUrl}\n`);
  console.log(`(if nothing opens, the URL is in ${urlFile})\n`);

  try {
    const opener =
      process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    execFileSync(opener, [authorizeUrl], { stdio: "ignore" });
  } catch {
    console.log(`Could not open a browser automatically — open the URL in ${urlFile}`);
  }
}
