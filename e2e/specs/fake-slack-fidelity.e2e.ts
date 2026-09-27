import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFake, type FakeProvider } from "../support/fake-provider.js";
import { SlackDriver } from "../../apps/connection-broker/src/drivers/slack.js";
import { PermissionDeniedError } from "../../apps/connection-broker/src/drivers/types.js";

/**
 * The fake Slack, driven by the REAL Slack driver.
 *
 * Same contract as the Confluence fidelity spec: the cluster specs rest on
 * this fake answering what the driver asks, and a fake that has drifted makes
 * them pass against a fiction.
 *
 * It also closes three gaps nothing else in this suite could reach:
 *
 *   AUTO-JOIN — the one WRITE any driver performs. #eng refuses the bot with
 *   `not_in_channel` until it joins, so the lazy recovery is asserted by its
 *   effect rather than by a flag.
 *
 *   A SECOND IDENTITY — every other deny path here is only as tested as the
 *   single account that existed. Two user tokens differ in what they can see,
 *   so "withheld from this caller" is distinguishable from "broken for
 *   everyone".
 *
 *   TOKEN TYPE — search.messages refuses a bot token outright, which is why
 *   live lookup is user-token-only by Slack's design rather than by scope.
 *
 * Needs no cluster and no credentials.
 */

const BOT = "e2e-slack-bot";
const USER_FULL = "e2e-slack-user-full";
const USER_LIMITED = "e2e-slack-user-limited";

const ENG = { channel: "CENG" };
const LEADS = { channel: "CLEADS" };

let fake: FakeProvider;

beforeAll(async () => {
  fake = await startFake("fake-slack.yaml", 18091);
});

afterAll(() => fake?.stop());

/** autoJoin off unless a test is about it — it is opt-in per Connection. */
const driver = (autoJoin = false) =>
  new SlackDriver({
    apiOrigin: `${fake.origin}/api`,
    workspaceUrl: "https://fake.slack.com",
    autoJoin,
  });

const reset = () => fake.introspect("/_e2e/reset");

describe("ingestion", () => {
  beforeAll(reset);

  it("lists thread PARENTS, not every message", async () => {
    // A single message is rarely a useful retrieval unit, and indexing per
    // message multiplies the corpus by the chattiness of the channel.
    const page = await driver(true).list(ENG, { service: BOT }, undefined);

    expect(page.resources.map((r) => r.id)).toEqual([
      "1700000001.000100",
      "1700000002.000200",
    ]);
  });

  it("assembles a thread into one document", async () => {
    const doc = await driver(true).fetch(ENG, { service: BOT }, "1700000001.000100");

    // The question and its answers together — the whole reason a thread is the
    // indexed unit.
    expect(doc.markdown).toContain("Roll back with the previous image tag");
    expect(doc.markdown).toContain("Do we need a change ticket first?");
    expect(doc.markdown).toContain("Only for a schema migration");
  });

  it("keeps a join event out of the indexed text", async () => {
    // System messages carry a subtype and are not prose; indexing them puts
    // "has joined the channel" into a client's corpus.
    const doc = await driver(true).fetch(ENG, { service: BOT }, "1700000001.000100");

    expect(doc.markdown).not.toContain("has joined the channel");
  });

  it("resolves author ids to names", async () => {
    const doc = await driver(true).fetch(ENG, { service: BOT }, "1700000001.000100");

    expect(doc.markdown).toContain("**@ada**");
    expect(doc.markdown).not.toContain("UADA");
  });

  it("refuses a channel outside the corpus's scope", async () => {
    await expect(
      driver(true).fetch(ENG, { service: BOT }, "1700000003.000300"),
    ).rejects.toThrow(PermissionDeniedError);
  });
});

describe("auto-join", () => {
  it("joins a channel it was refused, then succeeds", async () => {
    await reset();

    const page = await driver(true).list(ENG, { service: BOT }, undefined);

    expect(page.resources.length).toBeGreaterThan(0);
    const joined = await fake.introspect<string[]>("/_e2e/joined");
    expect(joined, "the driver never joined #eng").toContain("CENG");
  });

  it("does not join when the Connection did not ask for it", async () => {
    // The one write any driver performs: it changes workspace state and posts
    // a visible event, so it is an operator's decision, not a default.
    await reset();

    await expect(driver(false).list(ENG, { service: BOT }, undefined)).rejects.toThrow(
      PermissionDeniedError,
    );

    const joined = await fake.introspect<string[]>("/_e2e/joined");
    expect(joined).not.toContain("CENG");
  });

  it("never joins on a caller's PROBE", async () => {
    // Joining on a retrieval probe would change the answer rather than report
    // it — the caller would gain access by asking whether they had it.
    await reset();

    await expect(
      driver(true).probe(ENG, { delegated: USER_LIMITED }, "1700000001.000100"),
    ).resolves.toBeDefined();

    const joined = await fake.introspect<string[]>("/_e2e/joined");
    expect(joined).not.toContain("CENG");
  });
});

describe("the probe, with two identities", () => {
  beforeAll(reset);

  it("allows a caller who is in the channel", async () => {
    const result = await driver().probe(ENG, { delegated: USER_LIMITED }, "1700000001.000100");

    expect(result.allowed).toBe(true);
  });

  it("refuses a caller who is not, though the corpus indexed it", async () => {
    // The second identity earns its keep here: without it, a refusal is
    // indistinguishable from the channel being broken for everyone.
    await expect(
      driver().probe(LEADS, { delegated: USER_LIMITED }, "1700000003.000300"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  it("allows that same channel for a caller who can see it", async () => {
    const result = await driver().probe(LEADS, { delegated: USER_FULL }, "1700000003.000300");

    expect(result.allowed).toBe(true);
  });

  it("refuses the service credential outright", async () => {
    await expect(driver().probe(ENG, { service: BOT }, "1")).rejects.toThrow(/delegated token/);
  });
});

describe("live lookup", () => {
  beforeAll(reset);

  it("cannot run on a bot token, whatever scopes it holds", async () => {
    // Verified against the real workspace: search is user-token-only by
    // Slack's design, which suits us — it must run as the caller anyway.
    await expect(driver().searchAsUser({ service: BOT }, ENG, "deploys")).rejects.toThrow(
      /delegated token/,
    );
  });

  it("is bounded to the corpus's channel", async () => {
    // "deploys" appears in BOTH channels, so a bound that does nothing would
    // return the #leads message too. An empty query is not used here: the
    // driver refuses one outright, which would make this pass vacuously.
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, ENG, "deploys");

    expect(hits.length).toBeGreaterThan(0);
    // Asserted on the PERMALINK, not the id. The driver builds an id from the
    // scope's channel — `${scope.channel}/${ts}` — so a hit from anywhere
    // would still be labelled CENG/..., and an id assertion here could not
    // fail however broken the bound was. Mutation testing found that: removing
    // the driver's channel filter left this green.
    for (const hit of hits) expect(hit.url).toContain("/archives/CENG/");
  });

  it("is bounded even for a caller who CAN see the other channel", async () => {
    // USER_FULL sees #leads, so anything excluded here was excluded by the
    // corpus's scope rather than by the caller's own access — the two bounds
    // are separate and this is the one that is easy to lose.
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, ENG, "deploys");

    expect(hits.map((h) => h.url).some((u) => u.includes("/archives/CLEADS/"))).toBe(false);
    // And the text itself, which nothing in the driver can relabel.
    expect(hits.map((h) => h.excerpt ?? "").join(" ")).not.toContain("frozen");
  });

  it("cites `<channel>/<ts>`, which the read face takes", async () => {
    const hits = await driver().searchAsUser({ delegated: USER_FULL }, ENG, "deploys");

    expect(hits[0]!.id).toMatch(/^CENG\/\d+\.\d+$/);
    const doc = await driver().readAsUser({ delegated: USER_FULL }, hits[0]!.id);
    expect(doc.markdown).toContain("release branch");
  });
});
