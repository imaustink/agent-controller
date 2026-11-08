#!/usr/bin/env node
/**
 * Where do candidates disappear between Qdrant and the composed answer?
 *
 * The stages each drop candidates for different and legitimate reasons — RBAC
 * at the store, the ACL mirror's pre-filter, then the per-user probe — so "no
 * passages matched" is the same message whichever one did it. This prints the
 * count after each.
 *
 *   node orchestrator/apps/agent-orchestrator/scripts/debug-retrieval-stage.mjs <collection> <query>
 */
import { findEnvFile, loadEnv } from "../../connection-broker/scripts/lib/env.mjs";
import { OpenAIEmbedder } from "../../connection-broker/dist/embedder.js";
import { QdrantCorpusStore } from "../dist/knowledge-base/qdrant-corpus-store.js";
import { preFilter } from "../dist/knowledge-base/prefilter.js";
import { visibleMembers } from "../dist/knowledge-base/searcher.js";
import { searchCorpus } from "../dist/knowledge-base/search.js";

const COLLECTION = process.argv[2];
const QUERY = process.argv.slice(3).join(" ") || "what went wrong on this project";
const QDRANT = process.env.QDRANT_URL ?? "http://localhost:6333";

const env = loadEnv(findEnvFile());
const batching = new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });
const embedder = { embed: async (text) => (await batching.embed([text]))[0] };

const store = new QdrantCorpusStore({ url: QDRANT, collection: COLLECTION }, embedder);

console.log(`\nstage-by-stage for ${JSON.stringify(QUERY)} over ${COLLECTION}\n`);

for (const roles of [["reader"], ["reader", "writer"], ["guest"]]) {
  const hits = await store.query(QUERY, { callerRoles: roles }, 10);
  console.log(`store.query roles=${JSON.stringify(roles)} -> ${hits.length} hit(s)`);
  if (hits.length > 0) {
    const first = hits[0];
    console.log(`  top: ${first.score.toFixed(3)} ${first.chunk.title}`);
    console.log(`  acl: principals=${JSON.stringify(first.chunk.aclPrincipals)} permissive=${first.chunk.aclPermissive}`);
  }
}

// The pre-filter, with the principals a caller actually has here (none: the
// Atlassian token resolves to a token, and the stub supplies no principals).
const hits = await store.query(QUERY, { callerRoles: ["reader"] }, 10);
for (const principals of [[], ["user:someone"], ["user:someone", "group:eng"]]) {
  const kept = preFilter(hits, principals);
  console.log(`preFilter callerPrincipals=${JSON.stringify(principals)} -> ${kept.length}/${hits.length} kept`);
}


// Replicate the searcher's own path, step by step.
const member = {
  id: "a-corpus",
  label: "Confluence",
  collection: COLLECTION,
  allowedRoles: ["reader"],
  identityProviders: ["atlassian"],
  granularity: "resource",
};
const { visible, withheld } = visibleMembers([member], ["reader"]);
console.log(`\nvisibleMembers -> visible=${visible.length} withheld=${withheld}`);

const outcome = await searchCorpus([store], QUERY, ["reader"], 18);
console.log(`searchCorpus    -> hits=${outcome.hits.length} skipped=${outcome.skipped}`);
if (outcome.hits[0]) console.log(`  top: ${outcome.hits[0].chunk.title}`);
