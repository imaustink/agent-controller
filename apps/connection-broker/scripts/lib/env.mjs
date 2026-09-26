/**
 * Locating and reading the harnesses' credentials.
 *
 * Values are never printed by anything here. Callers get them as strings and
 * are expected to keep it that way — these scripts report SHAPES.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where credentials live, in preference order.
 *
 * `apps/connection-broker/.env` is the home: it sits beside the harnesses that
 * read it, so someone looking for it finds it. `tools/recipe-scraper/.env` is
 * where the Atlassian keys originally landed and is kept as a fallback so the
 * Confluence harness does not break mid-migration — it belongs to an unrelated
 * tool and nothing new should be added there.
 */
const CANDIDATE_PATHS = ["apps/connection-broker/.env", "tools/recipe-scraper/.env"];

/**
 * Finds the env file, checking the MAIN checkout as well as the cwd.
 *
 * A git worktree is a separate copy of the repo and `.env` is gitignored, so a
 * harness run from a worktree finds nothing — which is a confusing way to learn
 * that your credentials live somewhere else.
 */
export function findEnvFile(explicit) {
  const candidates = explicit ? [explicit] : [...CANDIDATE_PATHS];

  if (!explicit) {
    try {
      // The parent of the shared git dir is the main checkout.
      const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        encoding: "utf8",
      }).trim();
      for (const path of CANDIDATE_PATHS) candidates.push(join(common, "..", path));
    } catch {
      // Not a git checkout; the cwd-relative candidates are all there is.
    }
  }

  const found = candidates.find((candidate) => existsSync(candidate));
  if (found) return found;

  console.error("Could not find an env file with the harness credentials. Looked in:");
  for (const candidate of candidates) console.error(`  ${candidate}`);
  console.error("\nSee apps/connection-broker/.env.example for the keys each harness needs.");
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

/**
 * Fails with a readable list rather than one key at a time.
 *
 * A harness that dies on the first missing value sends you back to the console
 * three times for what is one trip.
 */
export function requireKeys(env, keys, harness) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length === 0) return;

  console.error(`\n${harness} needs these keys, which are absent or empty:`);
  for (const key of missing) console.error(`  ${key}`);
  console.error("\nSee apps/connection-broker/.env.example.");
  process.exit(1);
}
