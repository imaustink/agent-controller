#!/usr/bin/env node
/**
 * Drives the ORCHESTRATOR's knowledge-base path against a live broker, a live
 * Qdrant and a live Confluence tenant.
 *
 *   KnowledgeBaseSearcher -> QdrantCorpusStore -> Qdrant
 *                         -> per-user probe -> broker -> Confluence
 *   CorpusReader / CorpusLookup -> broker -> Confluence
 *
 * Everything below the orchestrator has now been verified live; the engines
 * have not. This is the layer that decides what an agent actually sees: the
 * probe that turns indexed chunks into an answer, the refusals when an
 * identity cannot be resolved, and whether a citation survives the trip.
 *
 *   node orchestrator/apps/agent-orchestrator/scripts/e2e-knowledge-base.mjs <collection> <SPACE>
 *
 * Needs the broker built, Qdrant holding a synced collection (run the broker
 * harness first), and the ATLASSIAN keys and OPENAI_API_KEY in the broker's .env.
 *
 * The ONE substitution is the credential resolver: the real one resolves a
 * caller's token from the identity-link gateway, which is separately tested
 * and would need a cluster. Everything it feeds is production code.
 */
import { findEnvFile, loadEnv } from "../../connection-broker/scripts/lib/env.mjs";
import { getAccessToken } from "../../connection-broker/scripts/lib/atlassian-auth.mjs";
import { ConfluenceDriver } from "../../connection-broker/dist/drivers/confluence.js";
import { StaticCorpusRegistry } from "../../connection-broker/dist/registry.js";
import { createBrokerServer } from "../../connection-broker/dist/server.js";
import { OpenAIEmbedder } from "../../connection-broker/dist/embedder.js";

import { KnowledgeBaseSearcher } from "../dist/knowledge-base/searcher.js";
import { CorpusReader } from "../dist/knowledge-base/reader.js";
import { CorpusLookup } from "../dist/knowledge-base/lookup.js";
import { QdrantCorpusStore } from "../dist/knowledge-base/qdrant-corpus-store.js";

const COLLECTION = process.argv[2];
const SPACE = process.argv[3];
if (!COLLECTION || !SPACE) {
  console.error("usage: e2e-knowledge-base.mjs <collection> <SPACE>");
  process.exit(1);
}

const CORPUS = `${SPACE.toLowerCase()}-confluence`;
const QDRANT = process.env.QDRANT_URL ?? "http://localhost:6333";
const ORCHESTRATOR_TOKEN = "orchestrator-secret";

const env = loadEnv(findEnvFile());
const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

const token = await getAccessToken({ env });
const sites = await (
  await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();
const site = sites[0];

const binding = {
  name: CORPUS,
  connection: "bitovi-confluence",
  driver: new ConfluenceDriver({ siteBaseUrl: `${site.url}/wiki`, cloudId: site.id }),
  scope: { space: SPACE },
  allowedRoles: ["reader"],
  serviceToken: token,
};

const server = createBrokerServer({
  auth: { orchestratorToken: ORCHESTRATOR_TOKEN, syncTokens: new Map([[CORPUS, "sync-secret"]]) },
  registry: new StaticCorpusRegistry([binding]),
});
await new Promise((resolve) => server.listen(0, resolve));
const brokerUrl = `http://127.0.0.1:${server.address().port}`;

console.log(`\norchestrator knowledge base: ${CORPUS} over ${COLLECTION}\n`);
ok(`broker on ${brokerUrl}`);

// The two engines' embedder interfaces differ: the broker batches
// (`embed(texts[]) -> number[][]`) because it embeds a whole sync pass, the
// orchestrator embeds one query (`embed(text) -> number[]`). Adapted here
// rather than papered over, since the broker's own length check caught the
// mismatch immediately — it read a 64-character string as 64 inputs.
const batching = new OpenAIEmbedder({ apiKey: env.OPENAI_API_KEY });
const embedder = { embed: async (text) => (await batching.embed([text]))[0] };
const openCorpus = async (collection) =>
  new QdrantCorpusStore({ url: QDRANT, collection }, embedder);

/** The caller's own Atlassian token. The real resolver reads it from the gateway. */
const credentials = {
  delegatedToken: async (_subject, providers) =>
    providers.includes("atlassian") ? { token, principals: [] } : undefined,
};

const member = {
  id: CORPUS,
  label: `${SPACE} Confluence`,
  collection: COLLECTION,
  allowedRoles: ["reader"],
  identityProviders: ["atlassian"],
  granularity: "resource",
};

const tool = (operation) => ({
  id: `kb:client/${operation}`,
  name: `${operation} client`,
  description: "…",
  allowedRoles: ["reader"],
  knowledgeBaseExec: {
    knowledgeBaseId: "client",
    displayName: "the client knowledge base",
    operation,
    members: [member],
    disclosePartialVisibility: true,
  },
});

const READER = { subject: "openwebui:e2e", roles: ["reader"] };

try {
  console.log("\n1. search — vector hits, each probed as the caller");
  const searcher = new KnowledgeBaseSearcher({
    openCorpus,
    credentials,
    brokerUrl,
    brokerToken: ORCHESTRATOR_TOKEN,
  });

  const found = await searcher.search(
    tool("search"),
    "what went wrong on this project and what would we do differently",
    READER,
  );
  if (found.needsLink) fail("search", new Error("asked for a link with a resolvable credential"));
  if (!found.result?.trim()) fail("search", new Error("empty result"));
  console.log(`${found.result.slice(0, 600).replace(/^/gm, "    ")}`);

  // A passage with no citation is unusable in an answer.
  if (!/https?:\/\//.test(found.result)) {
    fail("search", new Error("no citation URL survived into the composed answer"));
  }
  ok("passages came back with citations");

  console.log("\n2. search fails closed without an identity");
  // A corpus is client material: an unresolved caller must not get an
  // unfiltered search (ADR 0004).
  const anonymous = await searcher.search(tool("search"), "anything", { subject: "", roles: [] });
  if (/https?:\/\//.test(anonymous.result)) {
    fail("identity gate", new Error("an unidentified caller received passages"));
  }
  ok(`refused: ${anonymous.result.slice(0, 80)}`);

  console.log("\n3. read — one document live, as the caller");
  const reader = new CorpusReader({ brokerUrl, brokerToken: ORCHESTRATOR_TOKEN, credentials });

  // The reference shape the read tool takes, read straight off a citation.
  const idMatch = /pages\/(\d+)/.exec(found.result);
  if (!idMatch) {
    warn("no page id in the citations; skipping the read");
  } else {
    const read = await reader.read(tool("read"), `${CORPUS}/${idMatch[1]}`, READER);
    if (read.needsLink) fail("read", new Error("asked for a link with a resolvable credential"));
    if (!/Live read from/.test(read.result)) fail("read", new Error(read.result.slice(0, 200)));
    ok(`read back ${read.result.length} chars`);
  }

  console.log("\n4. read refuses a corpus outside the knowledge base");
  const outside = await reader.read(tool("read"), "someone-elses-corpus/1", READER);
  if (!/not part of/.test(outside.result)) {
    fail("read scope", new Error(`expected a refusal, got: ${outside.result.slice(0, 120)}`));
  }
  ok("named what IS readable instead of failing blankly");

  console.log("\n5. lookup — live search through the broker");
  const lookup = new CorpusLookup({ brokerUrl, brokerToken: ORCHESTRATOR_TOKEN, credentials });

  // The term comes from what SEARCH just returned, so "no hits" is a real
  // failure rather than a property of whichever space was passed in. A fixed
  // word made this unfalsifiable: an empty result reported "lookup answered"
  // and passed, which it did once on a transient empty response from the
  // source — exactly the run that should have been loud.
  const titles = [...found.result.matchAll(/^### \d+\. (.+)$/gm)].map((m) => m[1]);
  const term = (titles.join(" ").match(/[A-Za-z]{5,}/g) ?? [])[0];
  if (!term) {
    warn("no word in the search titles to look up; skipping");
  } else {
    const live = await lookup.lookup(tool("lookup"), term, READER);
    if (live.needsLink) fail("lookup", new Error("asked for a link with a resolvable credential"));
    console.log(`${live.result.slice(0, 400).replace(/^/gm, "    ")}`);

    if (/Could not search/.test(live.result)) {
      fail("lookup", new Error(`a member could not be searched: ${live.result.slice(0, 200)}`));
    }
    // Search found passages under these titles a moment ago, so the source
    // knowing nothing about the word is a fault, not an empty corpus.
    if (/^Nothing in /m.test(live.result)) {
      fail("lookup", new Error(`live search found nothing for ${JSON.stringify(term)}, which search had just matched`));
    }
    if (!/reference: /.test(live.result)) {
      fail("lookup", new Error("hits carried no `<corpus>/<id>` reference for the read tool"));
    }
    ok(`looked up ${JSON.stringify(term)} and got readable references back`);
  }

  console.log("\n6. a caller with no role reaches nothing");
  const stranger = await searcher.search(tool("search"), "anything", {
    subject: "openwebui:stranger",
    roles: ["guest"],
  });
  if (/https?:\/\//.test(stranger.result)) {
    fail("rbac", new Error("a caller holding no role received passages"));
  }
  ok(`refused: ${stranger.result.slice(0, 80)}`);

  console.log("\nPASS — the orchestrator's knowledge-base path works end to end.");
} finally {
  server.close();
}
