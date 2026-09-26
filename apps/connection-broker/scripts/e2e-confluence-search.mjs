#!/usr/bin/env node
/**
 * Drives the REAL Confluence searchAsUser against the live tenant.
 *
 * probe-confluence-search established which endpoint exists and what it
 * returns; this checks that the DRIVER maps it correctly — the ids it hands
 * back are readable, the citations resolve, and the space bound holds when the
 * caller tries to leave it.
 *
 *   node apps/connection-broker/scripts/e2e-confluence-search.mjs [SPACE] [query]
 *
 * Needs a built broker and the ATLASSIAN_* keys. Runs the OAuth dance, and
 * needs `search:confluence` among the granted scopes.
 */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { getAccessToken } from "./lib/atlassian-auth.mjs";
import { ConfluenceDriver } from "../dist/drivers/confluence.js";

const env = loadEnv(findEnvFile());

const SPACE = process.argv[2] ?? "BITOVI";
const QUERY = process.argv[3] ?? "deploy";

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

const SCOPES = [
  "read:page:confluence",
  "read:space:confluence",
  "read:content-details:confluence",
  "search:confluence",
  "offline_access",
].join(" ");

const token = await getAccessToken({ env, scopes: SCOPES });

const resources = await (
  await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();
const site = resources[0];

const driver = new ConfluenceDriver({
  cloudId: site.id,
  siteBaseUrl: `${site.url}/wiki`,
});

const scope = { space: SPACE };
const delegated = { delegated: token };

console.log(`\nconfluence search: ${SPACE} ~ ${JSON.stringify(QUERY)}\n`);

console.log("1. searchAsUser — inside the corpus's space");
let hits;
try {
  hits = await driver.searchAsUser(delegated, scope, QUERY);
} catch (e) {
  fail("searchAsUser", e);
}
if (hits.length === 0) fail("searchAsUser", new Error(`no hits for ${JSON.stringify(QUERY)}`));
ok(`${hits.length} hit(s)`);
for (const hit of hits.slice(0, 3)) {
  console.log(`    - ${hit.title}  [${hit.id}]`);
  console.log(`      ${hit.url}`);
  if (hit.excerpt) console.log(`      "${hit.excerpt.slice(0, 80).replace(/\s+/g, " ")}"`);
}

console.log("\n2. every hit is citable and readable");
const uncitable = hits.filter((hit) => !hit.id || !hit.url || !hit.title);
if (uncitable.length > 0) fail("search hits", new Error(`${uncitable.length} hit(s) missing id/url/title`));
ok("all hits carry an id, a title and a URL");

if (hits.some((hit) => /@@@hl@@@|@@@endhl@@@/.test(hit.excerpt ?? ""))) {
  fail("search hits", new Error("highlight sentinels leaked into an excerpt"));
}
ok("no @@@hl@@@ sentinels in the excerpts");

// The id search hands back must be one the read face can serve. This is the
// failure that would otherwise only appear when an agent followed a result:
// search returns folders and blogposts unless constrained to pages.
try {
  const doc = await driver.readAsUser(delegated, hits[0].id);
  ok(`the first hit reads back: ${JSON.stringify(doc.title)} (${doc.markdown.length} chars)`);
  if (doc.markdown.trim().length === 0) warn("…but its body is empty");
} catch (e) {
  fail("read a search hit", new Error(`search returned an id the read face cannot serve: ${e?.message ?? e}`));
}

console.log("\n3. the space bound holds");
// The control from the probe: this same query unbounded returns pages from
// other spaces on this tenant. Every hit must name the scoped space.
const strayUrls = hits.filter((hit) => !hit.url.includes(`/spaces/${SPACE}/`));
if (strayUrls.length > 0) {
  for (const hit of strayUrls) warn(`  ${hit.url}`);
  fail("scope bound", new Error(`${strayUrls.length} hit(s) came from outside ${SPACE}`));
}
ok(`all ${hits.length} hit(s) are in /spaces/${SPACE}/`);

console.log("\n4. a query that tries to escape the CQL literal");
// The query term is the CALLER's words and lands inside a double-quoted CQL
// literal. An unescaped quote would end the literal and let the rest parse as
// syntax — so this must come back as a search, not as an error and not as
// results from another space.
try {
  const evil = await driver.searchAsUser(delegated, scope, `" OR space = "Mindr`);
  const escaped = evil.filter((hit) => !hit.url.includes(`/spaces/${SPACE}/`));
  if (escaped.length > 0) {
    for (const hit of escaped) warn(`  ${hit.url}`);
    fail("CQL injection", new Error("a crafted query reached another space"));
  }
  ok(`handled as a literal: ${evil.length} hit(s), none outside ${SPACE}`);
} catch (e) {
  // Confluence rejecting it is also safe — what must not happen is results.
  ok(`refused by Confluence rather than escaping: ${e?.constructor?.name ?? "error"}`);
}

console.log("\n5. the service credential is refused");
try {
  await driver.searchAsUser({ service: token }, scope, QUERY);
  fail("credential check", new Error("searched on the SERVICE credential"));
} catch (e) {
  ok(`refused: ${e.message}`);
}

console.log("\nPASS — live Confluence search is scoped, citable and readable.");
