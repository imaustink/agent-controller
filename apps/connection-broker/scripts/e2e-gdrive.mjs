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
 *   node apps/connection-broker/scripts/e2e-gdrive.mjs
 *
 * Needs a built broker (npm run build -w connection-broker) and the GOOGLE_*
 * and GDRIVE_* keys in apps/connection-broker/.env — see .env.example.
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

// The CRD's folderID doc says contents sync RECURSIVELY, but list asks for
// `'<id>' in parents`, which is one level. If a subfolder was set up as
// .env.example instructs, its file should be here — and if it is not, the
// field doc is writing a cheque the driver does not cash.
const subfolders = page.resources.filter((r) => r.mimeType === "application/vnd.google-apps.folder");
if (subfolders.length > 0) {
  warn(`${subfolders.length} subfolder(s) appear as resources; check they are not indexed as files`);
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

const kinds = new Set(fetched.map(({ resource }) => resource.mimeType).filter(Boolean));
if (![...kinds].some((m) => m.startsWith("application/vnd.google-apps"))) {
  warn("no Google-native doc among the fetched files: the EXPORT path was not exercised");
}
if (![...kinds].some((m) => m && !m.startsWith("application/vnd.google-apps"))) {
  warn("no binary/plain file among the fetched files: the DOWNLOAD path was not exercised");
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

console.log("\nPASS — the real Drive driver works against a live Drive.");
console.log("Note: one Google account played BOTH the service and delegated roles, so");
console.log("the deny path is only as tested as that identity. Proving we withhold");
console.log("correctly needs a second account that cannot see the scoped folder.");
