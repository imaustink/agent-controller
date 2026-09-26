/**
 * Locating and reading the harnesses' credentials.
 *
 * Values are never printed by anything here. Callers get them as strings and
 * are expected to keep it that way — these scripts report SHAPES.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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

/** This file is `<repo>/apps/connection-broker/scripts/lib/env.mjs`. */
const OWN_REPO_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..", "..");

/**
 * Finds the env file, anchored to the checkout this SCRIPT lives in.
 *
 * Resolving the candidates against the cwd looks right until you run a harness
 * from the directory its `.env` is in: `apps/connection-broker/.env` becomes
 * `apps/connection-broker/apps/connection-broker/.env`, misses, and falls
 * through to another checkout's file — which then fails on missing KEYS rather
 * than a missing file, so the error names the wrong problem entirely.
 *
 * The script's own repo comes first: a worktree that has credentials should use
 * them rather than reach into the main checkout behind your back. The main
 * checkout stays as a fallback because `.env` is gitignored and so does not
 * travel into a fresh worktree.
 */
export function findEnvFile(explicit) {
  if (explicit) return existsSync(explicit) ? explicit : reportMissing([explicit]);

  const roots = [OWN_REPO_ROOT];
  try {
    // The parent of the shared git dir is the main checkout.
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      encoding: "utf8",
      cwd: OWN_REPO_ROOT,
    }).trim();
    roots.push(join(common, ".."));
  } catch {
    // Not a checkout; this script's own repo is all there is.
  }

  const candidates = roots.flatMap((root) => CANDIDATE_PATHS.map((path) => join(root, path)));

  const found = candidates.find((candidate) => existsSync(candidate));
  return found ?? reportMissing(candidates);
}

function reportMissing(candidates) {
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
