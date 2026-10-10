/**
 * Remembers a harness's refresh token between runs.
 *
 * Each live run otherwise costs a browser approval, and this suite is meant to
 * be run repeatedly — after a driver change, after a scope change, to check a
 * fix. A dance per run makes the cheap thing expensive, and the expensive
 * thing is exactly what should stay cheap.
 *
 * Written beside `.env` and gitignored alongside it, because that is what this
 * is: a long-lived credential for the same account. It holds a REFRESH token
 * only — access tokens expire in an hour and are not worth persisting.
 */
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CACHE = join(dirname(fileURLToPath(new URL(".", import.meta.url))), "..", "..", ".oauth-cache.json");

function read() {
  if (!existsSync(CACHE)) return {};
  try {
    return JSON.parse(readFileSync(CACHE, "utf8"));
  } catch {
    // A corrupt cache should cost one browser approval, not a failed run.
    return {};
  }
}

export function cachedRefreshToken(provider) {
  return read()[provider]?.refreshToken;
}

export function cacheRefreshToken(provider, refreshToken) {
  if (!refreshToken) return;
  const all = read();
  all[provider] = { refreshToken, savedAt: new Date().toISOString() };
  writeFileSync(CACHE, `${JSON.stringify(all, undefined, 2)}\n`);
  try {
    // Owner-only: it is a credential sitting in a working directory.
    chmodSync(CACHE, 0o600);
  } catch {
    // Best effort; a filesystem that will not chmod is not worth failing over.
  }
}
