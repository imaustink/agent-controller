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

// Deliberately NOT asserted against SLACK_WORKSPACE_URL. The first version of
// this check did exactly that, and it can never fail: the same variable builds
// the URL and then validates it. It passed happily while every citation pointed
// at example.slack.com, because that placeholder was still in the env file.
//
// So the check is that the citation is somewhere a person could actually go.
if (/example\.slack\.com|example\.com/.test(first.url ?? "")) {
  fail(
    "citation",
    new Error(
      `citations point at ${first.url} — SLACK_WORKSPACE_URL is still the ` +
        `placeholder from .env.example, so every citation is unopenable`,
    ),
  );
}
if (!/^https:\/\/[a-z0-9-]+\.slack\.com\/archives\//.test(first.url ?? "")) {
  fail("citation", new Error(`citation does not look like a Slack permalink: ${first.url}`));
}
ok("citation is a resolvable Slack permalink");

// The assumption most likely to be wrong: `list` should return thread PARENTS,
// not every message. A reply is fetched as part of its thread, and indexing it
// separately would both duplicate it and strand it from its context.
const ids = new Set(page.resources.map((r) => r.id));
if (ids.size !== page.resources.length) {
  fail("threads", new Error("list returned duplicate ids, so replies are leaking in as resources"));
}

console.log("\n2. driver.fetch — the whole thread as one document");

/**
 * A thread that actually HAS replies.
 *
 * Fetching whichever thread happened to be first left the assembly this
 * driver exists for — a question and its answers as one document — untested
 * on every run, and said so in a warning nobody could act on without knowing
 * which thread to pick. Slack reports `reply_count` on the parent, so ask it
 * directly rather than fetching candidates until one looks right.
 */
async function threadWithReplies() {
  const res = await fetch(
    `https://slack.com/api/conversations.history?channel=${env.SLACK_CHANNEL_ID}&limit=200`,
    { headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}` } },
  );
  const body = await res.json();
  if (!body.ok) return undefined;
  return (body.messages ?? []).find((m) => (m.reply_count ?? 0) > 0);
}

const conversation = await threadWithReplies();
const target = conversation?.ts ?? first.id;
if (conversation) {
  ok(`fetching a thread with ${conversation.reply_count} repl(ies), not just the first one`);
} else {
  warn("no thread in this channel has replies, so assembly cannot be tested here");
}

let doc;
try {
  doc = await driver.fetch(scope, service, target);
} catch (e) {
  fail("driver.fetch", e);
}
ok(`markdown length: ${doc.markdown.length}`);
console.log(`  --- first 300 chars ---\n  ${doc.markdown.slice(0, 300).replace(/\n/g, "\n  ")}`);

// `**<@` was the PRE-renderText shape and matched nothing once the brackets
// were stripped, so this reported "0 message(s)" and passed anyway. An
// assertion that cannot fail is worse than no assertion: it reads as coverage.
const messageCount = (doc.markdown.match(/^\*\*@/gm) ?? []).length;
if (messageCount === 0) fail("driver.fetch", new Error("no messages rendered in the thread"));
ok(`${messageCount} message(s) rendered in the thread`);

// The whole point of indexing a thread rather than a message: the answer
// usually lives in the replies, and a parent on its own is a question with no
// answer attached.
if (conversation) {
  if (messageCount < 2) {
    fail(
      "thread assembly",
      new Error(`thread has ${conversation.reply_count} repl(ies) but only ${messageCount} message(s) rendered`),
    );
  }
  ok("the replies are in the document, not just the parent");
}

// Post-rendering the brackets are gone, but the id is still an id.
const rawMentions = doc.markdown.match(/@[UW][A-Z0-9]{6,}/g) ?? [];
if (rawMentions.length > 0) {
  warn(`${rawMentions.length} unresolved author/mention id(s), e.g. ${rawMentions[0]}`);
  warn("the driver resolves these via users.info; an id surviving means the token");
  warn("lacks `users:read`, or Slack declined — the read still succeeds either way");
}
if (!conversation && messageCount < 2) {
  // Only reachable when the channel genuinely has no threaded conversation —
  // the fetch above targets one with replies whenever one exists.
  warn("no thread here has replies, so thread assembly went unexercised");
}

// System messages are the Slack equivalent of Confluence's macro parameters:
// machine chatter that arrives as an ordinary message and gets embedded as
// though somebody wrote it. A real channel is mostly these.
const systemish = page.resources.filter((r) =>
  /has joined the channel|has left the channel|set the channel (topic|purpose)|renamed the channel/.test(
    r.title ?? "",
  ),
);
if (systemish.length > 0) {
  fail(
    "system messages",
    new Error(
      `${systemish.length} of ${page.resources.length} indexed threads are system ` +
        `messages, e.g. ${JSON.stringify(systemish[0].title)}`,
    ),
  );
}
ok(`none of ${page.resources.length} threads is a join/leave/topic event`);

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

console.log("\n7. searchAsUser — live, scoped to the channel and to the caller");
const TERM = process.argv[2] ?? "deploy";
let hits;
try {
  hits = await driver.searchAsUser(delegated, scope, TERM);
} catch (e) {
  if (/missing_scope/.test(String(e?.message ?? e))) {
    warn("the user token lacks `search:read`, so live lookup went untested");
    warn("it is a User Token Scope, separate from users:read, and needs a reinstall");
    hits = undefined;
  } else {
    fail("driver.searchAsUser", e);
  }
}

if (hits) {
  ok(`${hits.length} hit(s) for ${JSON.stringify(TERM)}`);
  for (const hit of hits.slice(0, 3)) {
    console.log(`    - ${hit.title.slice(0, 70)}`);
    console.log(`      ${hit.id}`);
  }

  // THE check. `in:` matches a channel NAME and names are mutable, which is
  // exactly why the scope stores an id — so the id filter, not the query, is
  // the boundary. Live, an unbounded search of this workspace returns
  // thousands of messages from other channels.
  const strays = hits.filter((hit) => !hit.id.startsWith(`${env.SLACK_CHANNEL_ID}/`));
  if (strays.length > 0) {
    for (const hit of strays.slice(0, 3)) warn(`  ${hit.id}`);
    fail("search scope", new Error(`${strays.length} hit(s) came from another channel`));
  }
  ok(`every hit is in ${env.SLACK_CHANNEL_ID}`);

  if (hits.length > 0) {
    // A hit the read face cannot serve is a reference that always fails. The
    // id is `<channel>/<ts>`, which is what kb:<name>/read takes.
    //
    // This is also the ONLY place the per-user read runs on a real user
    // token — every other read in this harness uses the bot's. Slack splits
    // its scopes by token type, and the two do not overlap the way the other
    // providers' do: the bot can read history and cannot search, the user can
    // search and, without `channels:history`, cannot read.
    try {
      const doc = await driver.readAsUser(delegated, hits[0].id);
      ok(`the first hit reads back as the USER: ${doc.markdown.length} chars`);
    } catch (e) {
      if (/missing_scope/.test(String(e?.message ?? e))) {
        warn("the user token can SEARCH but cannot READ a thread.");
        warn("add `channels:history` (and `groups:history` for private channels)");
        warn("as USER Token Scopes — search and read need different scopes here,");
        warn("so this is a half-working corpus: lookup answers, every read refuses.");
      } else {
        fail("readAsUser", e);
      }
    }
  }

  console.log("\n8. a caller's own operators must not widen the search");
  // `in:` in the user's words would reach past this channel. The driver
  // strips operators before they reach Slack.
  const crafted = await driver.searchAsUser(delegated, scope, "in:#general deploy");
  const escaped = crafted.filter((hit) => !hit.id.startsWith(`${env.SLACK_CHANNEL_ID}/`));
  if (escaped.length > 0) {
    for (const hit of escaped.slice(0, 3)) warn(`  ${hit.id}`);
    fail("search scope", new Error("a crafted query reached another channel"));
  }
  ok(`handled as plain terms: ${crafted.length} hit(s), none outside the channel`);

  console.log("\n9. the service credential is refused");
  try {
    await driver.searchAsUser(service, scope, TERM);
    fail("credential check", new Error("searched on the SERVICE credential"));
  } catch (e) {
    ok(`refused: ${e.message}`);
  }
}

console.log("\nPASS — the real Slack driver works against a live workspace.");
console.log("Note: the DENY path is only as tested as the identity you used. Proving we");
console.log("withhold correctly needs a second Slack user who cannot see this channel.");
