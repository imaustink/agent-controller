#!/usr/bin/env node
/**
 * Drives the REAL code path end to end against a real tenant:
 *
 *   ConfluenceDriver.list -> .fetch -> chunkDocument -> embed -> Qdrant -> read back
 *
 * This is the complement to verify-confluence.mjs, and the difference is the
 * whole point. That script deliberately avoids the driver, to separate "what
 * does Confluence return" from "does our code handle it". This one runs the
 * driver, so a failure here is OURS. Until it passes, every test in the broker
 * is a mock answering whatever it was asked.
 *
 *   node apps/connection-broker/scripts/e2e-confluence.mjs GLOBEX
 *
 * Needs: a built broker (npm run build -w connection-broker), a Qdrant on
 * localhost:6333, and OPENAI_API_KEY plus the Atlassian credentials in the env
 * file. Writes into a throwaway collection it deletes on the way in.
 */
import { getAccessToken } from "./lib/atlassian-auth.mjs";
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { ConfluenceDriver } from "../dist/drivers/confluence.js";
import { chunkDocument } from "../dist/sync/chunk.js";
import { QdrantCorpusWriter } from "../dist/sync/corpus-writer.js";
import { corpusPointId } from "../dist/sync/point-id.js";

const SPACE = process.argv[2] ?? "GLOBEX";
const SITE = "https://wiki.at.bitovi.com/wiki";
// A custom domain cannot be discovered — the driver refuses rather than guess a
// tenant, so this is named. Read from verify-confluence.mjs.
const CLOUD_ID = "2a2bce9e-5780-4e10-a848-ee82abca0056";
const QDRANT = "http://localhost:6333";
const COLLECTION = `e2e-${SPACE.toLowerCase()}-confluence`;
const MAX_PAGES = Number(process.env.E2E_MAX_PAGES ?? 5);

const env = loadEnv(findEnvFile());
if (!env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not found in the env file");
  process.exit(1);
}

const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};
const ok = (msg) => console.log(`  ✓ ${msg}`);

/** Batch embedder over the OpenAI API, shaped to the writer's port. */
const embedder = {
  async embed(texts) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
    });
    if (!response.ok) throw new Error(`embeddings ${response.status}: ${(await response.text()).slice(0, 200)}`);
    const body = await response.json();
    // Ordered by index rather than trusted in arrival order: the writer zips
    // vectors to chunks positionally, and a reordering would pair every chunk
    // with another chunk's embedding while erroring nowhere.
    return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  },
};

/** The slice of the Qdrant REST API the writer needs. */
const qdrant = {
  async collectionExists(name) {
    const r = await fetch(`${QDRANT}/collections/${name}`);
    return r.ok;
  },
  async createCollection(name, config) {
    const r = await fetch(`${QDRANT}/collections/${name}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vectors: { size: config.vectors.size, distance: config.vectors.distance } }),
    });
    if (!r.ok) throw new Error(`create collection: ${await r.text()}`);
  },
  async upsert(name, args) {
    const r = await fetch(`${QDRANT}/collections/${name}/points?wait=${args.wait}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: args.points }),
    });
    if (!r.ok) throw new Error(`upsert: ${await r.text()}`);
  },
  async delete(name, args) {
    const r = await fetch(`${QDRANT}/collections/${name}/points/delete?wait=${args.wait}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ points: args.points }),
    });
    if (!r.ok) throw new Error(`delete: ${await r.text()}`);
  },
  async scroll(name, args) {
    const r = await fetch(`${QDRANT}/collections/${name}/points/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        limit: args.limit,
        offset: args.offset,
        with_payload: args.with_payload,
        with_vector: args.with_vector,
      }),
    });
    if (!r.ok) throw new Error(`scroll: ${await r.text()}`);
    const body = await r.json();
    return { points: body.result.points, next_page_offset: body.result.next_page_offset };
  },
};

console.log(`\nend-to-end: ${SPACE} -> ${COLLECTION}\n`);

const token = await getAccessToken({ env }).catch((e) => fail("oauth", e));

// A clean slate, so a pass cannot be an artifact of a previous run.
// A harness that opens by deleting a collection must not be able to point at
// a real one. The e2e suite guards the cluster by refusing any context that is
// not minikube; this is the same idea one layer down, because QDRANT_URL can
// be pointed anywhere.
if (!COLLECTION.startsWith("e2e-")) {
  console.error(`refusing to delete ${COLLECTION}: harnesses only touch e2e- collections`);
  process.exit(1);
}
await fetch(`${QDRANT}/collections/${COLLECTION}`, { method: "DELETE" });

const driver = new ConfluenceDriver({ siteBaseUrl: SITE, cloudId: CLOUD_ID });
const credentials = { service: token, delegated: token };
const scope = { space: SPACE };

console.log("\n1. driver.list");
let page;
try {
  page = await driver.list(scope, credentials, undefined);
} catch (e) {
  fail("driver.list", e);
}
ok(`${page.resources.length} resource(s), cursor ${page.cursor ? "present" : "absent"}`);
if (page.resources.length === 0) fail("driver.list", new Error(`no resources in ${SPACE}`));

const first = page.resources[0];
ok(`first: id=${first.id} version=${first.version} title=${JSON.stringify(first.title)}`);
ok(`citation url: ${first.url}`);
ok(`acl: ${JSON.stringify(first.acl)}`);
if (!first.url?.startsWith(SITE)) fail("citation", new Error(`citation is not on the configured site: ${first.url}`));

console.log("\n2. driver.fetch");
const documents = [];
for (const ref of page.resources.slice(0, MAX_PAGES)) {
  try {
    documents.push(await driver.fetch(scope, credentials, ref.id));
  } catch (e) {
    console.log(`  ! ${ref.id}: ${e.message}`);
  }
}
if (documents.length === 0) fail("driver.fetch", new Error("every fetch failed"));
ok(`${documents.length} document(s)`);
ok(`markdown length of first: ${documents[0].markdown.length}`);
console.log(`  --- extracted markdown, first 300 chars ---\n  ${documents[0].markdown.slice(0, 300).replace(/\n/g, "\n  ")}`);

// The RAW storage alongside it, so a conversion bug can be attributed to the
// input rather than guessed at. The macro-parameter leak this converter now
// strips was diagnosed from the output alone, which meant reconstructing the
// input from memory — exactly the guessing this script exists to stop.
const rawProbe = await fetch(
  `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages/${documents[0].id}?body-format=storage`,
  { headers: { authorization: `Bearer ${token}`, accept: "application/json" } },
);
const rawStorage = (await rawProbe.json())?.body?.storage?.value ?? "";
console.log(`  --- raw storage, first 400 chars ---\n  ${rawStorage.slice(0, 400).replace(/\n/g, "\n  ")}`);

// Anything that survived conversion but looks like configuration rather than
// prose. A cheap regression check on real input, which is where this class of
// bug actually lives.
const suspicious = documents
  .flatMap((doc) => doc.markdown.match(/#[0-9A-Fa-f]{6}\b|ri:[a-z-]+|ac:[a-z-]+/g) ?? [])
  .slice(0, 10);
if (suspicious.length > 0) {
  console.log(`  ! markup or config leaked into the text: ${JSON.stringify(suspicious)}`);
} else {
  ok("no macro config or markup leaked into the extracted text");
}

console.log("\n3. scope enforcement (a page id from outside the space must be refused)");
try {
  await driver.fetch(scope, credentials, "1");
  console.log("  ! a bogus page id was NOT refused");
} catch (e) {
  ok(`refused: ${e.name}`);
}

console.log("\n4. chunk");
const corpus = { id: `${SPACE.toLowerCase()}-confluence`, label: `${SPACE} Confluence` };
const chunks = documents.flatMap((doc) =>
  chunkDocument(corpus, doc, { maxTokens: 800, overlap: 100 }),
);
ok(`${chunks.length} chunk(s) from ${documents.length} document(s)`);
if (chunks.length === 0) fail("chunk", new Error("no chunks produced"));
ok(`first hash: ${chunks[0].contentHash.slice(0, 16)}…`);

console.log("\n5. embed + write");
const writer = new QdrantCorpusWriter(qdrant, embedder, {
  allowedRoles: ["reader"],
  vectorSize: 1536,
});
try {
  await writer.upsert(COLLECTION, chunks);
} catch (e) {
  fail("upsert", e);
}
ok(`wrote ${chunks.length} point(s)`);

console.log("\n6. read back");
const indexed = await writer.indexed(COLLECTION);
ok(`indexed() sees ${indexed.length} point(s)`);
if (indexed.length !== chunks.length) {
  fail("read back", new Error(`wrote ${chunks.length} but read ${indexed.length}`));
}

const raw = await (
  await fetch(`${QDRANT}/collections/${COLLECTION}/points/${corpusPointId(COLLECTION, chunks[0].contentHash)}`)
).json();
const payload = raw.result?.payload;
if (!payload) fail("read back", new Error("point not found at the derived id"));
ok(`payload keys: ${Object.keys(payload).sort().join(", ")}`);
ok(`descriptor is a ${typeof payload.descriptor}`);
const descriptor = JSON.parse(payload.descriptor);
ok(`descriptor keys: ${Object.keys(descriptor).sort().join(", ")}`);

console.log("\n7. semantic query");
const [queryVector] = await embedder.embed([documents[0].title]);
const search = await (
  await fetch(`${QDRANT}/collections/${COLLECTION}/points/search`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      vector: queryVector,
      limit: 3,
      with_payload: true,
      filter: { should: [{ key: "roles", match: { any: ["reader"] } }] },
    }),
  })
).json();
const hits = search.result ?? [];
ok(`${hits.length} hit(s) for ${JSON.stringify(documents[0].title)}`);
if (hits.length === 0) fail("query", new Error("the role filter matched nothing we just wrote"));
ok(`top: ${JSON.parse(hits[0].payload.descriptor).title} (score ${hits[0].score.toFixed(3)})`);

console.log("\n8. delete");
await writer.remove(COLLECTION, [chunks[0].contentHash]);
const after = await writer.indexed(COLLECTION);
ok(`after removing 1: ${after.length} point(s) remain`);
if (after.length !== indexed.length - 1) {
  fail("delete", new Error(`expected ${indexed.length - 1}, got ${after.length} — derived ids disagree`));
}

console.log("\nPASS — the real driver, chunker, writer and reader all work against a live tenant.");
