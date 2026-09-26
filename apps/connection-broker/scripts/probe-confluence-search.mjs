#!/usr/bin/env node
/**
 * Which Confluence search endpoint still exists, and under which scopes.
 *
 * Asked rather than assumed, because assuming is how this driver shipped
 * against v1 content endpoints that had already returned 410 Gone for months.
 * The deprecation covered /wiki/rest/api/content; whether it also took
 * /wiki/rest/api/search with it is exactly the kind of thing the docs are
 * cheerful about and the tenant is not.
 *
 *   node apps/connection-broker/scripts/probe-confluence-search.mjs
 *
 * Reports STATUS and shape. Prints no credential.
 */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { getAccessToken, GATEWAY } from "./lib/atlassian-auth.mjs";

const env = loadEnv(findEnvFile());

// Search may need a scope the sync path never asked for. Requesting the
// candidates up front means one browser trip instead of one per guess; the
// grant line in the output says which were actually given.
const SCOPES = [
  "read:page:confluence",
  "read:space:confluence",
  "read:content-details:confluence",
  "search:confluence",
  "offline_access",
].join(" ");

const token = await getAccessToken({ env, scopes: SCOPES });

const resources = await (
  await fetch(`${GATEWAY}/oauth/token/accessible-resources`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();

if (!Array.isArray(resources) || resources.length === 0) {
  console.error("no accessible Confluence sites for this token");
  process.exit(1);
}
console.log(`\nsites: ${resources.map((r) => r.url).join(", ")}`);

const cloudId = resources[0].id;
const base = `${GATEWAY}/ex/confluence/${cloudId}/wiki`;
// Discovered rather than required: each run costs a browser approval, so a
// missing argument should not burn one.
let SPACE = process.argv[2];
if (!SPACE) {
  const spaces = await (
    await fetch(`${base}/api/v2/spaces?limit=25`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    })
  ).json();
  const keys = (spaces.results ?? []).map((s) => s.key).filter(Boolean);
  if (keys.length === 0) {
    console.error("no spaces visible to this token");
    process.exit(1);
  }
  console.log(`spaces visible: ${keys.join(", ")}`);
  SPACE = keys[0];
}
const QUERY = process.argv[3] ?? "the";

console.log(`space=${SPACE} query=${JSON.stringify(QUERY)}\n`);

/** CQL wants the query literal quoted and its quotes escaped. */
const cql = (q) => `space = "${SPACE}" AND text ~ "${q.replace(/["\\]/g, "\\$&")}"`;

/** The first run returned a FOLDER as the top hit, so constrain the type. */
const cqlPages = (q) => `${cql(q)} AND type = page`;

const CANDIDATES = [
  ["search, any type", `${base}/rest/api/search?cql=${encodeURIComponent(cql(QUERY))}&limit=5`],
  ["search, type = page", `${base}/rest/api/search?cql=${encodeURIComponent(cqlPages(QUERY))}&limit=5`],
  // Does the space bound actually hold? A query with no space term should
  // return material this corpus must NOT surface; if the two agree, the bound
  // is decorative.
  ["no space bound (control)", `${base}/rest/api/search?cql=${encodeURIComponent(`text ~ "${QUERY}" AND type = page`)}&limit=5`],
];

for (const [label, url] of CANDIDATES) {
  let res;
  try {
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
  } catch (e) {
    console.log(`${label.padEnd(28)} NETWORK ${e.message}`);
    continue;
  }

  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    /* keep the raw text */
  }

  const count = Array.isArray(parsed?.results) ? parsed.results.length : "—";
  console.log(`${label.padEnd(28)} ${res.status} results=${count}`);

  if (!res.ok) {
    // The actionable part is in the body; a bare status sends you to check the
    // wrong thing, which is the mistake this whole script exists to avoid.
    console.log(`  ${body.slice(0, 220).replace(/\s+/g, " ")}`);
    continue;
  }

  const hits = parsed?.results ?? [];
  const types = hits.map((h) => (h.content ?? h).type ?? "?");
  console.log(`  types: ${types.join(", ")}`);
  const first = hits[0];
  if (first) {
    const content = first.content ?? first;
    console.log(`  first: id=${content.id ?? "?"} title=${JSON.stringify(content.title ?? first.title ?? null)}`);
    console.log(`  url: ${JSON.stringify(first.url ?? null)}`);
    console.log(`  container: ${JSON.stringify(first.resultGlobalContainer ?? null)}`);
    console.log(`  excerpt: ${JSON.stringify((first.excerpt ?? "").slice(0, 90))}`);
  }
}

console.log("\nWhat matters: a 200 with results, and whether the hit carries an id and title.");
