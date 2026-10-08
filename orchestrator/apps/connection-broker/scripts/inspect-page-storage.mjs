#!/usr/bin/env node
/**
 * Dumps one page's RAW storage format beside what the converter makes of it.
 *
 * For deciding whether an empty conversion is a bug or a page that genuinely
 * holds no prose — a question the converted output alone cannot answer.
 *
 *   node orchestrator/apps/connection-broker/scripts/inspect-page-storage.mjs <pageId>
 */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { getAccessToken } from "./lib/atlassian-auth.mjs";
import { storageToMarkdown } from "../dist/drivers/confluence.js";

const env = loadEnv(findEnvFile());
const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: inspect-page-storage.mjs <pageId> [pageId...]");
  process.exit(1);
}

const token = await getAccessToken({ env });
const resources = await (
  await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();
const base = `https://api.atlassian.com/ex/confluence/${resources[0].id}/wiki`;

for (const id of ids) {
  const res = await fetch(`${base}/api/v2/pages/${id}?body-format=storage`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    console.log(`\n=== ${id}: HTTP ${res.status}`);
    continue;
  }
  const page = await res.json();
  const storage = page.body?.storage?.value ?? "";
  const converted = storageToMarkdown(storage);

  console.log(`\n=== ${page.title} (${id})`);
  console.log(`raw storage: ${storage.length} chars`);
  console.log(`converted:   ${converted.length} chars`);

  // Which elements the page is actually made of, most common first. A page
  // that is entirely macros has no prose to lose.
  const tags = {};
  for (const [, tag] of storage.matchAll(/<([a-z][a-z0-9:-]*)\b/gi)) {
    tags[tag.toLowerCase()] = (tags[tag.toLowerCase()] ?? 0) + 1;
  }
  const top = Object.entries(tags)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([tag, n]) => `${tag}x${n}`)
    .join(" ");
  console.log(`elements:    ${top}`);

  console.log(`--- raw (first 500) ---\n${storage.slice(0, 500)}`);
  if (converted.length > 0) console.log(`--- converted (first 300) ---\n${converted.slice(0, 300)}`);
}
