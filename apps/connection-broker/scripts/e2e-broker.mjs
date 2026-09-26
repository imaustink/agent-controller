#!/usr/bin/env node
/**
 * Exercises the PRODUCTION path, not a hand-assembled approximation of it:
 *
 *   broker HTTP server + auth -> HttpResourceSource -> syncConnection ->
 *   reconcile -> QdrantCorpusWriter -> Qdrant
 *
 * Everything here is the real class the Deployment runs. The only substitution
 * is the registry: a static one stands in for the CRD-backed one, because
 * requiring a cluster would stop this being runnable.
 *
 * The second sync pass is the part worth having. It asserts that re-running
 * over unchanged content re-embeds NOTHING — which is the whole incremental
 * story, rests entirely on content hashes being stable across runs, and is
 * invisible to any test that syncs once.
 *
 *   node apps/connection-broker/scripts/e2e-broker.mjs GLOBEX
 */
import { getAccessToken } from "./lib/atlassian-auth.mjs";
import { findEnvFile, loadEnv } from "./lib/env.mjs";
import { ConfluenceDriver } from "../dist/drivers/confluence.js";
import { StaticCorpusRegistry } from "../dist/registry.js";
import { createBrokerServer } from "../dist/server.js";
import { HttpResourceSource } from "../dist/sync/http-source.js";
import { QdrantCorpusWriter } from "../dist/sync/corpus-writer.js";
import { QdrantHttpClient } from "../dist/sync/qdrant-client.js";
import { OpenAIEmbedder, EMBEDDING_DIMENSIONS } from "../dist/embedder.js";
import { syncConnection } from "../dist/sync/worker.js";

const SPACE = process.argv[2] ?? "GLOBEX";
const CORPUS = `${SPACE.toLowerCase()}-confluence`;
const CONNECTION = "bitovi-confluence";
const QDRANT = process.env.QDRANT_URL ?? "http://localhost:6333";
const COLLECTION = `e2e-broker-${CORPUS}`;
const ORCHESTRATOR_TOKEN = "orchestrator-secret";
const SYNC_TOKEN = "sync-secret";

const ok = (msg) => console.log(`  ✓ ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

const env = loadEnv(findEnvFile());
if (!env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not found in the env file");
  process.exit(1);
}

console.log(`\nbroker end-to-end: ${SPACE} -> ${COLLECTION}\n`);
const token = await getAccessToken({ env }).catch((e) => fail("oauth", e));

/**
 * The site URL and cloudId, ASKED FOR rather than pinned here.
 *
 * Both were hardcoded, and the site had gone stale — it named a custom domain
 * while the tenant's canonical address is elsewhere. Neither fails loudly: the
 * cloudId decides which tenant is read and a wrong one reads a DIFFERENT
 * site's content with every scope check still passing, while siteBaseUrl only
 * builds citations, so a wrong one produces links nobody can open and nothing
 * anywhere complains.
 *
 * `accessible-resources` reports both, for exactly the credential in hand, so
 * they cannot drift from each other or from the token.
 */
const sites = await (
  await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();
if (!Array.isArray(sites) || sites.length === 0) fail("site discovery", new Error("no accessible site"));
if (sites.length > 1) {
  // Picking one silently is how a harness reads the wrong tenant.
  fail("site discovery", new Error(`this token reaches ${sites.length} sites; name one explicitly`));
}
const SITE = `${sites[0].url}/wiki`;
const CLOUD_ID = sites[0].id;
ok(`site ${SITE} (cloudId ${CLOUD_ID})`);

// A harness that opens by deleting a collection must not be able to point at
// a real one. The e2e suite guards the cluster by refusing any context that is
// not minikube; this is the same idea one layer down, because QDRANT_URL can
// be pointed anywhere.
if (!COLLECTION.startsWith("e2e-")) {
  console.error(`refusing to delete ${COLLECTION}: harnesses only touch e2e- collections`);
  process.exit(1);
}
await fetch(`${QDRANT}/collections/${COLLECTION}`, { method: "DELETE" });

// The real registry is CRD-backed; a static one stands in so this runs without
// a cluster. Everything downstream of it is exactly what ships.
//
// One Corpus over one Connection (ADR 0043). The binding carries both names
// because data is addressed by corpus and webhooks arrive per connection.
const registry = new StaticCorpusRegistry([
  {
    name: CORPUS,
    connection: CONNECTION,
    driver: new ConfluenceDriver({ siteBaseUrl: SITE, cloudId: CLOUD_ID }),
    scope: { space: SPACE },
    allowedRoles: ["reader"],
    serviceToken: token,
  },
]);

const server = createBrokerServer({
  auth: {
    orchestratorToken: ORCHESTRATOR_TOKEN,
    syncTokens: new Map([[CORPUS, SYNC_TOKEN]]),
  },
  registry,
});
const port = await new Promise((resolve) => {
  server.listen(0, () => resolve(server.address().port));
});
ok(`broker listening on ${port}`);

const baseUrl = `http://127.0.0.1:${port}`;
const source = new HttpResourceSource({ baseUrl, token: SYNC_TOKEN });
const writer = new QdrantCorpusWriter(
  new QdrantHttpClient({ url: QDRANT }),
  new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY }),
  { allowedRoles: ["reader"], vectorSize: EMBEDDING_DIMENSIONS },
);

const target = { connection: CORPUS, label: `${SPACE} Confluence`, collection: COLLECTION };

console.log("\n1. first sync (over the broker's HTTP API)");
let first;
try {
  first = await syncConnection(source, writer, target, { maxPages: 2 });
} catch (e) {
  fail("first sync", e);
}
console.log(`  ${JSON.stringify(first)}`);
if (first.indexed === 0) fail("first sync", new Error("nothing was indexed"));
if (first.failed.length > 0) fail("first sync", new Error(`failed: ${first.failed.join(", ")}`));
if (!first.full) fail("first sync", new Error("a clean pass should be full, or it may never delete"));
ok(`indexed ${first.indexed}, full pass`);

console.log("\n2. second sync (nothing changed upstream)");
const second = await syncConnection(source, writer, target, { maxPages: 2 });
console.log(`  ${JSON.stringify(second)}`);
// The whole incremental story: content hashes stable across runs, so an
// unedited corpus costs fetches and zero embeddings.
if (second.indexed !== 0) {
  fail("incremental", new Error(`re-embedded ${second.indexed} unchanged chunk(s); hashes are not stable`));
}
if (second.unchanged !== first.indexed) {
  fail("incremental", new Error(`expected ${first.indexed} unchanged, saw ${second.unchanged}`));
}
if (second.removed !== 0) {
  fail("incremental", new Error(`deleted ${second.removed} chunk(s) that are still in the source`));
}
ok(`${second.unchanged} unchanged, 0 re-embedded, 0 deleted`);

console.log("\n3. probe (the retrieval path, as the orchestrator)");
const indexed = await writer.indexed(COLLECTION);
const sourceId = JSON.parse(
  (await (
    await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ limit: 1, with_payload: true, with_vector: false }),
    })
  ).json()).result.points[0].payload.descriptor,
).sourceId;

const probe = await fetch(`${baseUrl}/corpora/${CORPUS}/probe`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
    "x-delegated-token": token,
  },
  body: JSON.stringify({ sourceId }),
});
const probeBody = await probe.json();
if (!probe.ok || probeBody.allowed !== true) {
  fail("probe", new Error(`${probe.status} ${JSON.stringify(probeBody)}`));
}
ok(`allowed, title ${JSON.stringify(probeBody.title)}, version ${probeBody.version}`);
if (!probeBody.url?.startsWith(SITE)) fail("probe", new Error(`citation not on the site: ${probeBody.url}`));
ok("citation points at the human site");

console.log("\n4. authorization boundaries");
const cases = [
  [
    "a sync token cannot probe on behalf of a user",
    `${baseUrl}/corpora/${CORPUS}/probe`,
    { method: "POST", headers: { authorization: `Bearer ${SYNC_TOKEN}`, "content-type": "application/json" }, body: "{}" },
    403,
  ],
  [
    "the orchestrator cannot list (that spends the service credential)",
    `${baseUrl}/corpora/${CORPUS}/resources`,
    { headers: { authorization: `Bearer ${ORCHESTRATOR_TOKEN}` } },
    403,
  ],
  [
    "an unknown token reaches nothing",
    `${baseUrl}/corpora/${CORPUS}/resources`,
    { headers: { authorization: "Bearer nonsense" } },
    401,
  ],
  [
    "no token at all reaches nothing",
    `${baseUrl}/corpora/${CORPUS}/resources`,
    {},
    401,
  ],
];
for (const [name, url, init, expected] of cases) {
  const response = await fetch(url, init);
  if (response.status !== expected) {
    fail("authorization", new Error(`${name}: expected ${expected}, got ${response.status}`));
  }
  ok(`${name} (${expected})`);
}

console.log("\n5. deletion resolves at reconcile");
await writer.remove(COLLECTION, [indexed[0].contentHash]);
const third = await syncConnection(source, writer, target, { maxPages: 2 });
// The chunk is still in the source, so a full pass must put it back. This is
// the property that makes webhooks an optimization rather than a requirement.
if (third.indexed !== 1) {
  fail("reconcile", new Error(`expected the removed chunk to be restored, got indexed=${third.indexed}`));
}
ok("a chunk deleted behind the broker's back is restored by the next full pass");

server.close();
console.log("\nPASS — the production path works end to end against a live tenant.");
process.exit(0);
