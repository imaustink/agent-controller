#!/usr/bin/env node
/**
 * Lists the Atlassian sites and spaces this credential can reach.
 *
 * The site URL and cloudId are configuration a Connection has to carry, and
 * guessing either is how a corpus ends up pointed at the wrong tenant. They
 * are also the two values most likely to be stale in a harness, since neither
 * fails loudly — a wrong cloudId reads a DIFFERENT site's content while every
 * scope check still passes.
 *
 *   node orchestrator/apps/connection-broker/scripts/discover-atlassian.mjs [filter]
 *
 * `filter` narrows the space list by key or name, case-insensitively.
 */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { getAccessToken, GATEWAY } from "./lib/atlassian-auth.mjs";

const env = loadEnv(findEnvFile());
const FILTER = (process.argv[2] ?? "").toLowerCase();

const token = await getAccessToken({ env });

const sites = await (
  await fetch(`${GATEWAY}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();

if (!Array.isArray(sites) || sites.length === 0) {
  console.error("this credential reaches no Atlassian site");
  process.exit(1);
}

console.log("\nSITES — the `site.baseURL` and `site.cloudId` a Connection needs:\n");
for (const site of sites) {
  console.log(`  url:     ${site.url}`);
  console.log(`  cloudId: ${site.id}`);
  console.log(`  name:    ${site.name ?? "(unnamed)"}`);
  console.log(`  scopes:  ${(site.scopes ?? []).length} granted`);
  console.log();
}

// Spaces live per site; with one site the choice is made for us.
const site = sites[0];
const base = `${GATEWAY}/ex/confluence/${site.id}/wiki`;

const spaces = [];
let cursor;
do {
  const url = new URL(`${base}/api/v2/spaces`);
  url.searchParams.set("limit", "100");
  if (cursor) url.searchParams.set("cursor", cursor);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.error(`space listing failed: ${res.status}`);
    break;
  }
  const body = await res.json();
  spaces.push(...(body.results ?? []));
  // v2 paginates with an opaque cursor inside _links.next.
  const next = body._links?.next;
  cursor = next ? new URL(next, base).searchParams.get("cursor") : undefined;
} while (cursor);

// Personal spaces (`~accountid`) are noise for this purpose and there are
// usually far more of them than real ones.
const real = spaces.filter((space) => !String(space.key ?? "").startsWith("~"));
const shown = FILTER
  ? real.filter((space) =>
      `${space.key} ${space.name}`.toLowerCase().includes(FILTER),
    )
  : real;

console.log(`SPACES — ${real.length} non-personal (${spaces.length} total)${FILTER ? `, matching ${JSON.stringify(FILTER)}` : ""}:\n`);
for (const space of shown) {
  console.log(`  ${String(space.key).padEnd(12)} ${space.name ?? ""} [id ${space.id}]`);
}
if (shown.length === 0) console.log("  (nothing matched)");
