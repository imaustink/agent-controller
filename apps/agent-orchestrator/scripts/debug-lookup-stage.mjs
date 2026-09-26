#!/usr/bin/env node
/** Broker search route vs CorpusLookup, over the same live binding. */
import { findEnvFile, loadEnv } from "../../connection-broker/scripts/lib/env.mjs";
import { getAccessToken } from "../../connection-broker/scripts/lib/atlassian-auth.mjs";
import { ConfluenceDriver } from "../../connection-broker/dist/drivers/confluence.js";
import { StaticCorpusRegistry } from "../../connection-broker/dist/registry.js";
import { createBrokerServer } from "../../connection-broker/dist/server.js";
import { CorpusLookup } from "../dist/knowledge-base/lookup.js";

const [SPACE, QUERY] = process.argv.slice(2);
if (!SPACE || !QUERY) {
  console.error("usage: debug-lookup-stage.mjs <SPACE> <query>");
  process.exit(1);
}
const CORPUS = `${SPACE.toLowerCase()}-confluence`;

const env = loadEnv(findEnvFile());
const token = await getAccessToken({ env });
const sites = await (
  await fetch("https://api.atlassian.com/oauth/token/accessible-resources", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  })
).json();

const driver = new ConfluenceDriver({ siteBaseUrl: `${sites[0].url}/wiki`, cloudId: sites[0].id });

// 1. the driver directly
const direct = await driver.searchAsUser({ delegated: token }, { space: SPACE }, QUERY);
console.log(`driver.searchAsUser        -> ${direct.length} hit(s)`);

const server = createBrokerServer({
  auth: { orchestratorToken: "orch", syncTokens: new Map([[CORPUS, "sync"]]) },
  registry: new StaticCorpusRegistry([
    { name: CORPUS, connection: "c", driver, scope: { space: SPACE }, allowedRoles: ["reader"], serviceToken: token },
  ]),
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

try {
  // 2. the broker route
  const res = await fetch(
    `${base}/corpora/${CORPUS}/search?q=${encodeURIComponent(QUERY)}`,
    { headers: { authorization: "Bearer orch", "x-delegated-token": token } },
  );
  const body = await res.json();
  console.log(`broker /search             -> ${res.status} hits=${body.hits?.length ?? "-"} ${body.error ?? ""}`);

  // 3. CorpusLookup
  const lookup = new CorpusLookup({
    brokerUrl: base,
    brokerToken: "orch",
    credentials: { delegatedToken: async () => ({ token, principals: [] }) },
  });
  const tool = {
    id: "kb:x/lookup",
    knowledgeBaseExec: {
      knowledgeBaseId: "x",
      displayName: "X",
      operation: "lookup",
      members: [
        {
          id: CORPUS,
          label: "Confluence",
          collection: "unused",
          allowedRoles: ["reader"],
          identityProviders: ["atlassian"],
        },
      ],
      disclosePartialVisibility: true,
    },
  };
  const out = await lookup.lookup(tool, QUERY, { subject: "s", roles: ["reader"] });
  console.log(`CorpusLookup.lookup        -> ${out.result.split("\n")[0]}`);
} finally {
  server.close();
}
