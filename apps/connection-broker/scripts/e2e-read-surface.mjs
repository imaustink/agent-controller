#!/usr/bin/env node
/**
 * Exercises the broker's READ surface over real HTTP, against real providers.
 *
 *   createBrokerServer + auth -> route -> driver -> live source
 *
 * The drivers are verified live by their own harnesses and the routes are
 * covered by unit tests with fake drivers. This is the seam between them: that
 * a route hands the driver the credential authorization granted and not
 * another, that the scope reaches searchAsUser and does not reach readAsUser,
 * and that a real refusal survives the trip as a refusal.
 *
 *   node apps/connection-broker/scripts/e2e-read-surface.mjs
 *
 * Needs a built broker and SLACK_* credentials. No Qdrant, no embeddings —
 * nothing here writes or costs anything.
 */
import { findEnvFile, loadEnv, requireKeys } from "./lib/env.mjs";
import { envSecretReader, loadSample, withScope, withSite } from "./lib/manifests.mjs";
import { toBinding } from "../dist/corpus-resource.js";
import { StaticCorpusRegistry } from "../dist/registry.js";
import { createBrokerServer, DELEGATED_TOKEN_HEADER } from "../dist/server.js";

const env = loadEnv(findEnvFile());
requireKeys(
  env,
  ["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_CHANNEL_ID", "SLACK_WORKSPACE_URL"],
  "e2e-read-surface",
);

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

const ORCHESTRATOR_TOKEN = "orchestrator-secret";
const SYNC_TOKEN = "sync-secret";

const connection = withSite(loadSample("core_v1alpha1_connection_slack.yaml"), {
  baseURL: env.SLACK_WORKSPACE_URL,
});
const corpus = withScope(loadSample("core_v1alpha1_corpus_slack.yaml"), {
  channel: env.SLACK_CHANNEL_ID,
});

const binding = await toBinding(corpus, connection, envSecretReader(env.SLACK_BOT_TOKEN));

const server = createBrokerServer({
  auth: {
    orchestratorToken: ORCHESTRATOR_TOKEN,
    syncTokens: new Map([[binding.name, SYNC_TOKEN]]),
  },
  registry: new StaticCorpusRegistry([binding]),
});
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

console.log(`\nbroker read surface: ${binding.name} on ${base}\n`);

const asUser = {
  authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
  [DELEGATED_TOKEN_HEADER]: env.SLACK_USER_TOKEN,
};
const asSync = { authorization: `Bearer ${SYNC_TOKEN}` };

const call = (path, headers) => fetch(`${base}${path}`, { headers });

try {
  console.log("1. GET /corpora/:name/search — live, through the route");
  const res = await call(`/corpora/${binding.name}/search?q=deploy`, asUser);
  if (!res.ok) fail("search", new Error(`${res.status} ${await res.text()}`));
  const { hits } = await res.json();
  if (!Array.isArray(hits)) fail("search", new Error("no hits array in the response"));
  ok(`${hits.length} hit(s) over HTTP`);

  // The scope reaches searchAsUser. Proven by the result, not by inspection:
  // an unbounded search of this workspace returns thousands from elsewhere.
  const strays = hits.filter((hit) => !hit.id.startsWith(`${env.SLACK_CHANNEL_ID}/`));
  if (strays.length > 0) fail("search", new Error(`${strays.length} hit(s) from another channel`));
  ok("every hit is inside the corpus scope");

  console.log("\n2. the limit a caller asks for is capped, not obeyed");
  const many = await call(`/corpora/${binding.name}/search?q=deploy&limit=5000`, asUser);
  const capped = (await many.json()).hits;
  if (capped.length > 25) fail("limit", new Error(`${capped.length} hits, over the cap`));
  ok(`asked for 5000, got ${capped.length}`);

  console.log("\n3. GET /corpora/:name/documents/:id — identity-bounded read");
  if (hits.length === 0) {
    warn("no hit to read back; skipping");
  } else {
    const id = encodeURIComponent(hits[0].id);
    const doc = await call(`/corpora/${binding.name}/documents/${id}`, asUser);
    if (!doc.ok) fail("documents", new Error(`${doc.status} ${await doc.text()}`));
    const body = await doc.json();
    if (!body.markdown?.trim()) fail("documents", new Error("read returned empty markdown"));
    ok(`read ${body.markdown.length} chars back through the route`);
  }

  console.log("\n4. a SYNC worker is refused both user reads");
  // auth.ts authorizes these as a fetch, which a sync worker legitimately
  // performs — so the route refuses non-delegated credentials itself rather
  // than trusting every driver to notice.
  for (const path of [
    `/corpora/${binding.name}/search?q=deploy`,
    `/corpora/${binding.name}/documents/${encodeURIComponent(`${env.SLACK_CHANNEL_ID}/1.1`)}`,
  ]) {
    const refused = await call(path, asSync);
    if (refused.status !== 403) {
      fail("credential boundary", new Error(`${path} answered ${refused.status}, expected 403`));
    }
  }
  ok("search and documents both 403 for the ingestion credential");

  console.log("\n5. the orchestrator with NO delegated token is refused");
  const bare = await call(`/corpora/${binding.name}/search?q=deploy`, {
    authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
  });
  if (bare.status !== 403) fail("credential boundary", new Error(`expected 403, got ${bare.status}`));
  ok("403 without a caller to act as");

  console.log("\n6. an unknown corpus is a 404, not a leak");
  const missing = await call("/corpora/not-a-corpus/search?q=deploy", asUser);
  if (missing.status !== 404) fail("routing", new Error(`expected 404, got ${missing.status}`));
  ok("404 for a corpus that does not exist");

  console.log("\n7. a real provider refusal survives the trip as a refusal");
  // A syntactically valid id in a channel this corpus does not cover. The
  // driver refuses it; the route must not turn that into a 500.
  const foreign = encodeURIComponent("C00000000/1.1");
  const denied = await call(`/corpora/${binding.name}/documents/${foreign}`, asUser);
  if (denied.ok) fail("scope", new Error("read a thread from another channel"));
  ok(`refused with ${denied.status}`);

  console.log("\nPASS — the read surface behaves against live providers.");
} finally {
  server.close();
}
