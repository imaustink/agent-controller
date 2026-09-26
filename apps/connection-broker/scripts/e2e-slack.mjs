#!/usr/bin/env node
/**
 * Drives the REAL Slack driver against a real workspace.
 *
 * Every Slack test in the broker suite is a mock answering whatever it was
 * asked. This one asks Slack. Until it passes, the driver's assumptions —
 * thread grouping, the replies shape, what a channel probe returns, which
 * error strings mean what — are guesses, and the Confluence work established
 * that roughly one guess per driver is wrong.
 *
 *   node apps/connection-broker/scripts/e2e-slack.mjs
 *
 * Needs a built broker (npm run build -w connection-broker) and the SLACK_*
 * keys in apps/connection-broker/.env — see .env.example.
 *
 * No OAuth dance: Slack issues both tokens from the app page. It does NOT
 * write to Qdrant; this is about the driver, and e2e-broker.mjs covers the
 * write path.
 */
import { findEnvFile, loadEnv, requireKeys } from "./lib/env.mjs";
import { envSecretReader, loadSample, withScope, withSite } from "./lib/manifests.mjs";
import { toBinding } from "../dist/corpus-resource.js";

const env = loadEnv(findEnvFile());
requireKeys(
  env,
  ["SLACK_BOT_TOKEN", "SLACK_USER_TOKEN", "SLACK_CHANNEL_ID", "SLACK_WORKSPACE_URL"],
  "e2e-slack",
);

const ok = (msg) => console.log(`  ✓ ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
const fail = (step, err) => {
  console.error(`\n✗ ${step}\n  ${err?.stack ?? err}`);
  process.exit(1);
};

console.log(`\nslack end-to-end: ${env.SLACK_CHANNEL_ID}\n`);

// The committed samples, pointed at whichever channel is under test. Going
// through toBinding means the join, the allowedScopes cap and driver
// construction are all production code — only the Secret lookup is substituted.
const connection = withSite(loadSample("core_v1alpha1_connection_slack.yaml"), {
  baseURL: env.SLACK_WORKSPACE_URL,
});
const corpus = withScope(loadSample("core_v1alpha1_corpus_slack.yaml"), {
  channel: env.SLACK_CHANNEL_ID,
});

console.log("0. bind the Corpus to its Connection");
let binding;
try {
  binding = await toBinding(corpus, connection, envSecretReader(env.SLACK_BOT_TOKEN));
} catch (e) {
  fail("toBinding", e);
}
ok(`corpus ${binding.name} over connection ${binding.connection}`);
ok(`driver ${binding.driver.provider}, scope ${JSON.stringify(binding.scope)}`);

const { driver, scope } = binding;
const service = { service: binding.serviceToken };
const delegated = { delegated: env.SLACK_USER_TOKEN };

console.log("\n1. driver.list — thread parents only");
let page;
try {
  page = await driver.list(scope, service, undefined);
} catch (e) {
  fail("driver.list", e);
}
ok(`${page.resources.length} thread(s), cursor ${page.cursor ? "present" : "absent"}`);
if (page.resources.length === 0) {
  fail("driver.list", new Error("no threads — is the app in the channel, and does it have history?"));
}

const first = page.resources[0];
ok(`first: id=${first.id} version=${first.version}`);
ok(`title: ${JSON.stringify(first.title)}`);
ok(`citation url: ${first.url}`);
ok(`acl: ${JSON.stringify(first.acl)}`);
if (!first.url?.startsWith(env.SLACK_WORKSPACE_URL)) {
  fail("citation", new Error(`citation is not on the configured workspace: ${first.url}`));
}

// The assumption most likely to be wrong: `list` should return thread PARENTS,
// not every message. A reply is fetched as part of its thread, and indexing it
// separately would both duplicate it and strand it from its context.
const ids = new Set(page.resources.map((r) => r.id));
if (ids.size !== page.resources.length) {
  fail("threads", new Error("list returned duplicate ids, so replies are leaking in as resources"));
}

console.log("\n2. driver.fetch — the whole thread as one document");
let doc;
try {
  doc = await driver.fetch(scope, service, first.id);
} catch (e) {
  fail("driver.fetch", e);
}
ok(`markdown length: ${doc.markdown.length}`);
console.log(`  --- first 300 chars ---\n  ${doc.markdown.slice(0, 300).replace(/\n/g, "\n  ")}`);

const messageCount = (doc.markdown.match(/\*\*<@/g) ?? []).length;
ok(`${messageCount} message(s) rendered in the thread`);
if (messageCount < 2) {
  // Not fatal — the channel may have no replies — but it means the part of the
  // driver that exists to keep a question with its answer went unexercised.
  warn("this thread has no replies, so thread assembly was not really tested");
  warn("re-run against a channel with a real back-and-forth to cover it");
}

// Anything that survived rendering but looks like raw Slack markup.
const leaked = doc.markdown.match(/<#C[A-Z0-9]+\||<https?:[^>]*\||&amp;|&lt;/g) ?? [];
if (leaked.length > 0) {
  warn(`unrendered slack markup in the text: ${JSON.stringify(leaked.slice(0, 5))}`);
  warn("it will be embedded as written — the Confluence driver had the same class of bug");
} else {
  ok("no raw slack markup leaked into the text");
}

console.log("\n3. scope enforcement");
try {
  await driver.fetch({ channel: "C000000000" }, service, first.id);
  fail("scope", new Error("a thread in another channel was NOT refused"));
} catch (e) {
  ok(`a foreign channel is refused: ${e.name}`);
}

console.log("\n4. probe — as the USER, at channel granularity");
if (driver.probeGranularity() !== "connection") {
  fail("probe", new Error(`expected connection granularity, got ${driver.probeGranularity()}`));
}
ok("granularity is per connection, so one probe settles every candidate");

let probe;
try {
  probe = await driver.probe(scope, delegated);
} catch (e) {
  fail("driver.probe", e);
}
ok(`allowed=${probe.allowed} title=${JSON.stringify(probe.title)}`);
ok(`url: ${probe.url}`);
if (probe.version !== undefined) {
  warn(`probe reported a version (${probe.version}); a Slack channel has none, so this is a bug`);
}

console.log("\n5. the probe refuses the service credential");
try {
  await driver.probe(scope, service);
  fail("probe", new Error("probing on the ingestion credential was allowed"));
} catch (e) {
  // It would answer a different question, permissively (ADR 0040).
  ok(`refused: ${e.message}`);
}

console.log("\n6. a channel the user cannot see");
// Best-effort: needs a private channel the bot is not in. Reported rather than
// asserted, because one may not exist in this workspace.
try {
  const result = await driver.probe({ channel: "C000000000" }, delegated);
  warn(`a nonexistent channel probed as allowed=${result.allowed}, which should not happen`);
} catch (e) {
  ok(`refused: ${e.name}`);
}

console.log("\nPASS — the real Slack driver works against a live workspace.");
console.log("Note: the DENY path is only as tested as the identity you used. Proving we");
console.log("withhold correctly needs a second Slack user who cannot see this channel.");
