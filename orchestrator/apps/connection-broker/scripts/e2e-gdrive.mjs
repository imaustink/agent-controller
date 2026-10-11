#!/usr/bin/env node
/**
 * Drives the REAL Google Drive driver against a real Drive.
 *
 * Every Drive test in the broker suite is a mock answering whatever it was
 * asked. This one asks Google. The Confluence run established that roughly one
 * guess per driver is wrong — there it was the whole v1 API being gone — and
 * this driver carries the least-exercised code in the set: the parent-chain
 * walk that decides whether a file is inside the corpus at all.
 *
 *   node orchestrator/apps/connection-broker/scripts/e2e-gdrive.mjs
 *
 * Needs a built broker (npm run build -w connection-broker) and the GOOGLE_*
 * and GDRIVE_* keys in orchestrator/apps/connection-broker/.env — see .env.example.
 *
 * Unlike Slack, this runs an OAuth dance: Drive has no equivalent of a bot
 * token you can paste. Both the service and delegated roles are played by the
 * SAME account here, which is a real limit on what the deny path proves — see
 * the closing note.
 */
import { findEnvFile, loadEnv, requireKeys } from "./lib/env.mjs";
import { envSecretReader, loadSample, withScope } from "./lib/manifests.mjs";
import { getAccessToken } from "./lib/google-auth.mjs";
import { toBinding } from "../dist/corpus-resource.js";

const env = loadEnv(findEnvFile());
requireKeys(env, ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GDRIVE_FOLDER_ID"], "e2e-gdrive");

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

console.log(`\ngdrive end-to-end: ${env.GDRIVE_FOLDER_ID}\n`);

const token = await getAccessToken({ env });

const connection = loadSample("core_v1alpha1_connection_gdrive.yaml");
const corpus = withScope(loadSample("core_v1alpha1_corpus_gdrive.yaml"), {
  folderID: env.GDRIVE_FOLDER_ID,
});

console.log("\n0. bind the Corpus to its Connection");
let binding;
try {
  binding = await toBinding(corpus, connection, envSecretReader(token));
} catch (e) {
  fail("toBinding", e);
}
ok(`corpus ${binding.name} over connection ${binding.connection}`);
ok(`driver ${binding.driver.provider}, scope ${JSON.stringify(binding.scope)}`);

const { driver, scope } = binding;
const service = { service: binding.serviceToken };
// The same human either way. This exercises the delegated CODE PATH, not a
// genuine privilege difference — see the closing note.
const delegated = { delegated: token };

/**
 * Asks Drive directly, bypassing the driver.
 *
 * Used only to establish GROUND TRUTH about what is in the folder. Anything
 * the driver is being tested on goes through the driver.
 */
async function driveQuery(accessToken, q) {
  const url =
    "https://www.googleapis.com/drive/v3/files" +
    `?q=${encodeURIComponent(q)}&fields=${encodeURIComponent("files(id,name,mimeType)")}&pageSize=100`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    warn(`ground-truth query failed (${res.status}); some checks will be skipped`);
    return [];
  }
  return (await res.json()).files ?? [];
}

console.log("\n1. driver.list — the folder's indexable files");
let page;
try {
  page = await driver.list(scope, service, undefined);
} catch (e) {
  fail("driver.list", e);
}
if (page.resources.length === 0) {
  fail("driver.list", new Error(`no indexable files in ${env.GDRIVE_FOLDER_ID}`));
}
ok(`${page.resources.length} file(s)${page.cursor ? ", cursor present" : ""}`);
for (const resource of page.resources.slice(0, 5)) {
  console.log(`    - ${resource.title ?? "(untitled)"}  [${resource.id}]`);
}

// Does the corpus actually reach a SUBFOLDER's files?
//
// The CRD's folderID doc says contents sync recursively; `list` asks for
// `'<id>' in parents`, which is one level. This cannot be settled from
// `page.resources` — the driver filters folders out before returning — so ask
// Drive directly and compare against what the driver listed.
const subfolders = await driveQuery(
  token,
  `'${env.GDRIVE_FOLDER_ID}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
);
if (subfolders.length === 0) {
  warn("no subfolder in the scoped folder, so RECURSION went untested");
  warn("put a file inside a subfolder as .env.example describes and re-run");
} else {
  const nested = (
    await Promise.all(
      subfolders.map((folder) =>
        driveQuery(token, `'${folder.id}' in parents and trashed = false`),
      ),
    )
  ).flat();

  const listed = new Set(page.resources.map((r) => r.id));
  const missed = nested.filter((file) => !listed.has(file.id));

  if (missed.length === 0 && nested.length > 0) {
    ok(`recursion holds: ${nested.length} file(s) in subfolders are all listed`);
  } else if (nested.length > 0) {
    // Not a harness failure — a documented behaviour that does not match the
    // code. Reported precisely so the fix can be to either one.
    warn(`${missed.length} of ${nested.length} file(s) in subfolders are NOT listed`);
    warn("`list` queries `'<id>' in parents`, which is ONE level, but the CRD's");
    warn("folderID doc says contents sync RECURSIVELY — one of the two is wrong");
    for (const file of missed.slice(0, 3)) warn(`  ${file.name} [${file.id}]`);
  }
}

console.log("\n2. driver.fetch — export vs download");
const fetched = [];
for (const resource of page.resources.slice(0, 5)) {
  try {
    const doc = await driver.fetch(scope, service, resource.id);
    fetched.push({ resource, doc });
    const shape = doc.markdown.trim().length > 0 ? `${doc.markdown.length} chars` : "EMPTY";
    ok(`${resource.title}: ${shape}`);
  } catch (e) {
    warn(`${resource.title}: ${e?.constructor?.name ?? "error"} — ${e?.message ?? e}`);
  }
}
if (fetched.length === 0) fail("driver.fetch", new Error("nothing in the folder could be fetched"));

const empty = fetched.filter(({ doc }) => doc.markdown.trim().length === 0);
if (empty.length > 0) {
  warn(`${empty.length} file(s) fetched to EMPTY text — an empty chunk is worse than no chunk`);
  for (const { resource } of empty) warn(`  ${resource.title} (${resource.mimeType ?? "?"})`);
}

// Which read path each file took.
//
// A ResourceRef carries no mimeType — the driver does not put one there — so
// an earlier version of this check compared `resource.mimeType` against
// undefined and BOTH warnings fired at once, on files that are plainly one or
// the other. A check that can never pass is worth no more than one that can
// never fail. The citation URL is real evidence: Drive gives native docs a
// docs.google.com/<kind>/ link and everything else a drive.google.com/file/
// one.
const native = fetched.filter(({ resource }) => /docs\.google\.com\/(document|spreadsheets|presentation)\//.test(resource.url));
const binary = fetched.filter(({ resource }) => /drive\.google\.com\/file\//.test(resource.url));

if (native.length > 0) ok(`${native.length} Google-native doc(s): the EXPORT path ran`);
else warn("no Google-native doc among the fetched files: the EXPORT path was not exercised");

if (binary.length > 0) ok(`${binary.length} plain/binary file(s): the DOWNLOAD path ran`);
else warn("no plain/binary file among the fetched files: the DOWNLOAD path was not exercised");

// PDFs are downloaded and PARSED, which is the one path with a dependency
// behind it. A folder with no PDF leaves that untested — and PDFs were
// silently dropped entirely until recently, so this says so rather than
// staying quiet.
const pdfs = fetched.filter(({ resource }) => /\.pdf$/i.test(resource.title ?? ""));
if (pdfs.length > 0) {
  const empty = pdfs.filter(({ doc }) => doc.markdown.trim().length === 0);
  if (empty.length > 0) {
    fail("pdf extraction", new Error(`${empty.length} PDF(s) extracted to EMPTY text`));
  }
  ok(`${pdfs.length} PDF(s) extracted to text: e.g. ${pdfs[0].doc.markdown.slice(0, 60).replace(/\s+/g, " ")}`);
} else {
  warn("no PDF among the fetched files: EXTRACTION was not exercised");
  warn("drop a PDF in the folder and re-run — this is the one path with a parser behind it");
}

console.log("\n3. scope enforcement — the parent-chain walk");
// The least-validated code in this driver. A file id that is real but lives
// outside the corpus must be refused, and the only way to be sure the walk
// runs is to hand it something real from outside.
let outsider;
try {
  const roots = await driver.list({ folderID: "root" }, service, undefined);
  outsider = roots.resources.find(
    (r) => !page.resources.some((inCorpus) => inCorpus.id === r.id),
  );
} catch (e) {
  warn(`could not list My Drive root to find an outside file: ${e?.message ?? e}`);
}

if (!outsider) {
  warn("no file outside the corpus was available, so scope enforcement went UNTESTED");
  warn("put a file in My Drive root that is not in the scoped folder and re-run");
} else {
  try {
    await driver.fetch(scope, service, outsider.id);
    fail(
      "scope enforcement",
      new Error(`fetched ${outsider.id}, which is OUTSIDE ${env.GDRIVE_FOLDER_ID}`),
    );
  } catch (e) {
    if (e?.constructor?.name === "PermissionDeniedError") {
      ok(`a file outside the folder is refused: ${e.constructor.name}`);
    } else {
      fail("scope enforcement", new Error(`refused, but with the wrong error: ${e?.message ?? e}`));
    }
  }
}

console.log("\n4. probe — as the USER, per resource");
ok(`granularity is "${driver.probeGranularity()}", so every candidate costs a probe`);
try {
  const result = await driver.probe(scope, delegated, fetched[0].resource.id);
  ok(`allowed=${result.allowed} title=${JSON.stringify(result.title ?? null)}`);
  if (result.url) ok(`url: ${result.url}`);
  if (!result.allowed) {
    warn("the probing account cannot see a file it just fetched — check which account you linked");
  }
} catch (e) {
  fail("driver.probe", e);
}

console.log("\n5. a file that does not exist");
try {
  const result = await driver.probe(scope, delegated, "thisFileIdDoesNotExist000000000");
  if (result.allowed) fail("probe", new Error("a nonexistent file probed as ALLOWED"));
  ok("refused rather than granted");
} catch (e) {
  if (e?.constructor?.name === "PermissionDeniedError") ok(`refused: ${e.constructor.name}`);
  else fail("probe", new Error(`wrong error for a missing file: ${e?.message ?? e}`));
}

console.log("\n6. readAsUser — identity-bounded, no scope check");
try {
  const doc = await driver.readAsUser(delegated, fetched[0].resource.id);
  ok(`read ${JSON.stringify(doc.title ?? null)} as the caller`);
} catch (e) {
  fail("driver.readAsUser", e);
}

console.log("\n7. searchAsUser — live, scoped to the folder and to the caller");
// Never run against Google before now: the Drive half of live lookup was
// implemented from the API docs and unit-tested against mocks only.
const TERM = process.argv[2] ?? "bio";
try {
  const hits = await driver.searchAsUser(delegated, scope, TERM);
  ok(`${hits.length} hit(s) for ${JSON.stringify(TERM)}`);
  for (const hit of hits.slice(0, 3)) console.log(`    - ${hit.title}  [${hit.id}]`);

  if (hits.length > 0) {
    // The bound that cannot be expressed in the query: `'<id>' in parents` is
    // one level, so scope is enforced by the parent walk afterwards. Every hit
    // must be something driver.list would also have returned.
    const listed = new Set(page.resources.map((r) => r.id));
    const stray = hits.filter((hit) => !listed.has(hit.id));
    if (stray.length > 0) {
      for (const hit of stray) warn(`  ${hit.title} [${hit.id}]`);
      fail("search scope", new Error(`${stray.length} hit(s) are outside the corpus`));
    }
    ok("every hit is inside the scoped folder");

    // A hit the read face cannot serve is a reference that always fails.
    const doc = await driver.readAsUser(delegated, hits[0].id);
    ok(`the first hit reads back: ${JSON.stringify(doc.title ?? null)}`);
  } else {
    warn(`no hit for ${JSON.stringify(TERM)} — pass a term as argv[2] to exercise this properly`);
  }
} catch (e) {
  fail("driver.searchAsUser", e);
}

console.log("\n8. a search that must NOT escape the folder");
try {
  // A term chosen to match widely across the whole Drive. Anything it returns
  // has to have survived the parent walk.
  const wide = await driver.searchAsUser(delegated, scope, "the");
  const listed = new Set(page.resources.map((r) => r.id));
  const stray = wide.filter((hit) => !listed.has(hit.id));
  if (stray.length > 0) {
    for (const hit of stray.slice(0, 3)) warn(`  ${hit.title} [${hit.id}]`);
    fail("search scope", new Error("a broad search reached outside the corpus"));
  }
  ok(`a broad term returned ${wide.length} hit(s), all inside the folder`);
} catch (e) {
  fail("driver.searchAsUser", e);
}

console.log("\n9. PDF extraction, against a real PDF");
// The scoped folder holds only Google Docs, so this looks across the Drive the
// caller can already see. Clearly OUTSIDE the corpus, and read through
// readAsUser, which is identity-bounded by design — the same access the person
// has by opening it themselves.
const anyPdf = await driveQuery(
  token,
  "mimeType = 'application/pdf' and trashed = false",
);
if (anyPdf.length === 0) {
  warn("no PDF anywhere in this Drive, so extraction remains unexercised");
} else {
  const target = anyPdf[0];
  try {
    const doc = await driver.readAsUser(delegated, target.id);
    const text = doc.markdown.trim();
    if (text.length === 0) {
      warn(`${target.name}: extracted to EMPTY text`);
      warn("a scanned PDF has no text layer; that is a real limit, not a bug");
    } else {
      ok(`${target.name}: ${text.length} chars extracted`);
      console.log(`      "${text.slice(0, 120).replace(/\s+/g, " ")}"`);
    }
  } catch (e) {
    fail("pdf extraction", e);
  }
}

console.log("\nPASS — the real Drive driver works against a live Drive.");
console.log("Note: one Google account played BOTH the service and delegated roles, so");
console.log("the deny path is only as tested as that identity. Proving we withhold");
console.log("correctly needs a second account that cannot see the scoped folder.");
