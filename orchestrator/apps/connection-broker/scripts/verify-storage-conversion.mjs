#!/usr/bin/env node
/**
 * Runs the storage-format conversion over REAL pages.
 *
 * The unit tests pin the cases the old regex converter got wrong. This asks
 * the question they cannot: does the parser still handle whatever a live wiki
 * actually contains? The hand-rolled version's worst bug — dropping
 * `ac:layout-cell`, which holds the page body — looked fine in every test
 * until it met a page that used a layout.
 *
 *   node orchestrator/apps/connection-broker/scripts/verify-storage-conversion.mjs [SPACE] [n]
 *
 * Reports shapes. Prints page text, which is the point, but no credential.
 */
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { getAccessToken } from "./lib/atlassian-auth.mjs";
import { ConfluenceDriver, storageToMarkdown } from "../dist/drivers/confluence.js";

const env = loadEnv(findEnvFile());
const SPACE = process.argv[2] ?? "BITOVI";
const SAMPLE = Number(process.argv[3] ?? 12);

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

const token = await getAccessToken({ env });
const resources = await (
  await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();
const site = resources[0];

const driver = new ConfluenceDriver({ cloudId: site.id, siteBaseUrl: `${site.url}/wiki` });
const scope = { space: SPACE };
const credentials = { service: token };

console.log(`\nstorage conversion over real pages: ${SPACE}\n`);

let page;
try {
  page = await driver.list(scope, credentials, undefined);
} catch (e) {
  fail("driver.list", e);
}
ok(`${page.resources.length} page(s) listed`);

const sample = page.resources.slice(0, SAMPLE);

/**
 * Raw storage, fetched directly.
 *
 * The comparison that matters is converted-vs-RAW, not converted alone. A page
 * that comes back empty proves nothing on its own: the first run of this
 * flagged four, and all four turned out to hold literally `<p />` — blank
 * parent pages whose children Confluence renders from the page tree. Judging
 * emptiness without the input is how a real body-dropping bug would hide among
 * them, and how blank pages get mistaken for one.
 */
async function rawStorage(id) {
  const res = await fetch(`${apiBase}/api/v2/pages/${id}?body-format=storage`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (!res.ok) return undefined;
  return (await res.json()).body?.storage?.value ?? "";
}

const apiBase = `https://api.atlassian.com/ex/confluence/${site.id}/wiki`;

/** Every tag removed, nothing interpreted. Deliberately not the converter. */
const crudeStrip = (html) => html.replace(/<[^>]*>/g, " ");
const letters = (text) => (text.match(/[A-Za-z]/g) ?? []).length;

const blank = [];
const dropped = [];
const suspicious = [];
let converted = 0;
let shortest = null;

for (const ref of sample) {
  const storage = await rawStorage(ref.id);
  if (storage === undefined) {
    warn(`${ref.title}: could not read raw storage`);
    continue;
  }

  let text;
  try {
    text = storageToMarkdown(storage).trim();
  } catch (e) {
    fail("storageToMarkdown", new Error(`${ref.title}: ${e?.message ?? e}`));
  }

  if (text.length === 0) {
    // Was there prose to lose?
    //
    // Storage SIZE is the wrong measure, which took two runs to see. A page
    // holding one centred image, or a single `children` macro, is hundreds of
    // characters of markup and contains no writing at all — converting it to
    // nothing is correct. Both were flagged as bugs before this.
    //
    // `prose` is measured crudely and INDEPENDENTLY of the converter: strip
    // every tag and count letters. It over-includes, since it keeps macro
    // parameters the converter rightly drops, which is the direction that
    // makes it a useful cross-check — it cannot miss a body the converter
    // dropped, because it does not share the converter's idea of what a body
    // is.
    if (letters(crudeStrip(storage)) > 40) dropped.push([ref, storage.length]);
    else blank.push(ref);
    continue;
  }

  converted += 1;
  if (!shortest || text.length < shortest.text.length) shortest = { ref, text };

  if (/<[a-z/!][^>]*>/i.test(text)) suspicious.push([ref, "raw markup survived"]);
  else if (/&(nbsp|amp|lt|gt|mdash|rsquo|#\d+);/i.test(text)) suspicious.push([ref, "undecoded entity"]);
  else if (/#[0-9A-F]{6}\b/.test(text)) suspicious.push([ref, "looks like macro colour config"]);
}

console.log(`\nconverted ${converted}/${sample.length} page(s) to non-empty text`);

if (blank.length > 0) {
  ok(`${blank.length} page(s) held no prose (blank, or only an image or macro) and correctly produced none`);
}

if (dropped.length > 0) {
  for (const [ref, size] of dropped) warn(`  ${size} chars of storage, with prose in it -> nothing: ${ref.title} (${ref.url})`);
  fail("conversion", new Error(`${dropped.length} page(s) with WRITING in them converted to nothing`));
}
ok("every page with content in the source produced text");

if (suspicious.length > 0) {
  warn(`${suspicious.length} page(s) carry something that should not be there:`);
  for (const [ref, why] of suspicious.slice(0, 5)) warn(`  ${why}: ${ref.title}`);
} else {
  ok("no raw markup, undecoded entities or macro config in the converted text");
}

if (shortest) {
  console.log(`\nshortest non-empty page — ${shortest.ref.title}`);
  console.log(`${shortest.text.slice(0, 400).replace(/\n/g, "\n  ")}`);
}

console.log("\nPASS — real pages convert to prose.");
