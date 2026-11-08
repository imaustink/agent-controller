import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createHmac } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrokerServer, DELEGATED_TOKEN_HEADER } from "../../orchestrator/apps/connection-broker/src/server.js";
import { StaticCorpusRegistry } from "../../orchestrator/apps/connection-broker/src/registry.js";
import { SlackDriver } from "../../orchestrator/apps/connection-broker/src/drivers/slack.js";
import { HttpResourceSource } from "../../orchestrator/apps/connection-broker/src/sync/http-source.js";
import { BrokerProber } from "../../orchestrator/apps/agent-orchestrator/src/knowledge-base/retrieve.js";
import { CorpusReader } from "../../orchestrator/apps/agent-orchestrator/src/knowledge-base/reader.js";
import { CorpusLookup } from "../../orchestrator/apps/agent-orchestrator/src/knowledge-base/lookup.js";

/**
 * Every client of the connection-broker, driven against the REAL broker server.
 *
 * The broker's routes and the four clients that call them live in three
 * packages and two languages, and nothing but agreement makes them work. That
 * agreement has now broken twice, both times silently, both times in a release
 * that looked complete:
 *
 *   - `HttpResourceSource` asked for `/connections/:name/resources` after
 *     ADR 0043 moved data to `/corpora/`. Every sync request 404'd, so the
 *     write path could not list or fetch anything at all.
 *   - `BrokerProber` asked for `/connections/:name/probe` for the same reason.
 *     Worse, both engines read 404 as a DENIAL, so every probe was counted as
 *     "this caller may not see it" and retrieval answered "No passages
 *     matched" — indistinguishable from an empty corpus. Knowledge-base search
 *     returned nothing, in both engines, always.
 *
 * Both survived a full unit suite, because the unit tests asserted the URL each
 * client BUILT. Both sides of those checks came from one assumption, so a
 * rename could move the server and leave the client behind with nothing going
 * red. Only running the two together can catch it, and that is all this does.
 *
 * Like `rbac-parity`, this needs NO cluster and NO credentials — the drivers
 * are fakes and the question is purely whether the two halves of this repo
 * agree. It should turn red in seconds on a laptop rather than after a deploy,
 * which is why it runs in CI while the cluster specs do not.
 */

const CORPUS = "globex-confluence";
const ORCHESTRATOR_TOKEN = "orchestrator-secret";
const SYNC_TOKEN = "sync-secret";

/** A driver that answers everything, so a 404 can only mean a routing fault. */
function fakeDriver() {
  return {
    provider: "confluence",
    validateScope: () => {},
    list: vi.fn().mockResolvedValue({
      resources: [{ id: "1", title: "Runbook", url: "https://wiki/1" }],
      cursor: undefined,
    }),
    fetch: vi.fn().mockResolvedValue({
      id: "1",
      title: "Runbook",
      url: "https://wiki/1",
      markdown: "body",
    }),
    probeGranularity: () => "resource" as const,
    probe: vi.fn().mockResolvedValue({
      allowed: true,
      title: "Runbook",
      url: "https://wiki/1",
      version: "v1",
    }),
    readAsUser: vi.fn().mockResolvedValue({
      id: "1",
      title: "Runbook",
      url: "https://wiki/1",
      markdown: "live body",
    }),
    searchAsUser: vi.fn().mockResolvedValue([
      { id: "1", title: "Runbook", url: "https://wiki/1", excerpt: "deploy steps" },
    ]),
  };
}

let server: Server;
let baseUrl: string;
let driver: ReturnType<typeof fakeDriver>;

beforeAll(async () => {
  driver = fakeDriver();
  server = createBrokerServer({
    auth: {
      orchestratorToken: ORCHESTRATOR_TOKEN,
      syncTokens: new Map([[CORPUS, SYNC_TOKEN]]),
    },
    registry: new StaticCorpusRegistry([
      {
        name: CORPUS,
        connection: "bitovi-confluence",
        driver: driver as never,
        scope: { space: "GLOBEX" },
        allowedRoles: ["reader"],
        serviceToken: "service-cred",
      },
    ]),
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => server?.close());

/** The caller's own token. Its value is irrelevant; that one is SENT is not. */
const DELEGATED = "user-token";

const credentials = {
  delegatedToken: async () => ({ token: DELEGATED, principals: [] }),
  // The reader/lookup paths exercised here only call delegatedToken; this
  // satisfies the multi-member search method on the same resolver interface.
  delegatedTokens: async (_subject: string, providers: string[]) =>
    new Map(providers.map((provider) => [provider, { token: DELEGATED, principals: [] }])),
};

describe("the sync worker's client", () => {
  it("lists through the route the broker serves", async () => {
    const source = new HttpResourceSource({ baseUrl, token: SYNC_TOKEN });

    const page = await source.list(CORPUS, undefined);

    expect(page.resources.map((r) => r.id)).toEqual(["1"]);
    expect(driver.list).toHaveBeenCalled();
  });

  it("fetches through the route the broker serves", async () => {
    const source = new HttpResourceSource({ baseUrl, token: SYNC_TOKEN });

    const doc = await source.fetch(CORPUS, "1");

    expect(doc.markdown).toBe("body");
    expect(driver.fetch).toHaveBeenCalled();
  });
});

describe("the retrieval prober", () => {
  it("probes through the route the broker serves, carrying the caller's token", async () => {
    const prober = new BrokerProber({
      baseUrl,
      token: ORCHESTRATOR_TOKEN,
      delegatedToken: DELEGATED,
    });

    const result = await prober.probe({ connectionId: CORPUS, sourceId: "1" });

    expect(result.allowed).toBe(true);
    // The credential the probe spends is the CALLER's, never the corpus's.
    const [, credsArg] = driver.probe.mock.calls.at(-1)!;
    expect(credsArg).toEqual({ delegated: DELEGATED });
  });

  it("does not report a missing corpus as a denial", async () => {
    // The distinction that made the routing bug invisible: a 404 counted as
    // "you may not see this", so a dead route drained every result silently.
    const prober = new BrokerProber({
      baseUrl,
      token: ORCHESTRATOR_TOKEN,
      delegatedToken: DELEGATED,
    });

    await expect(
      prober.probe({ connectionId: "no-such-corpus", sourceId: "1" }),
    ).rejects.toThrow(/broker returned 404/);

    // And specifically NOT the denial type, which drops candidates quietly.
    await prober
      .probe({ connectionId: "no-such-corpus", sourceId: "1" })
      .catch((err: Error) => {
        expect(err.constructor.name).toBe("TransientProbeError");
      });
  });
});

describe("the knowledge-base read and lookup clients", () => {
  const tool = (operation: string) =>
    ({
      id: `kb:globex/${operation}`,
      name: operation,
      description: "…",
      allowedRoles: ["reader"],
      knowledgeBaseExec: {
        knowledgeBaseId: "globex",
        displayName: "GLOBEX",
        operation,
        members: [
          {
            id: CORPUS,
            label: "GLOBEX Confluence",
            collection: "c1",
            allowedRoles: ["reader"],
            identityProviders: ["atlassian"],
          },
        ],
        disclosePartialVisibility: true,
      },
    }) as never;

  const caller = { subject: "openwebui:1", roles: ["reader"] };

  it("reads a document through the route the broker serves", async () => {
    const reader = new CorpusReader({ brokerUrl: baseUrl, brokerToken: ORCHESTRATOR_TOKEN, credentials });

    const read = await reader.read(tool("read"), `${CORPUS}/1`, caller);

    expect(read.result).toContain("live body");
    expect(driver.readAsUser).toHaveBeenCalled();
  });

  it("looks up through the route the broker serves", async () => {
    const lookup = new CorpusLookup({ brokerUrl: baseUrl, brokerToken: ORCHESTRATOR_TOKEN, credentials });

    const found = await lookup.lookup(tool("lookup"), "deploy", caller);

    // The reference shape the read tool takes, so the pair composes.
    expect(found.result).toContain(`reference: ${CORPUS}/1`);
    expect(driver.searchAsUser).toHaveBeenCalled();
  });
});

describe("the ingestion credential never reaches a user-facing read", () => {
  // auth.ts authorizes both user reads as a `fetch`, which a sync worker
  // legitimately performs — so the ROUTE refuses a non-delegated credential
  // rather than trusting every driver to notice.
  it.each([
    ["search", `/corpora/${CORPUS}/search?q=deploy`],
    ["documents", `/corpora/${CORPUS}/documents/1`],
  ])("refuses a sync worker on %s", async (_name, path) => {
    const res = await fetch(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${SYNC_TOKEN}` },
    });

    expect(res.status).toBe(403);
  });

  it("refuses the orchestrator with no caller to act as", async () => {
    const res = await fetch(`${baseUrl}/corpora/${CORPUS}/search?q=deploy`, {
      headers: { authorization: `Bearer ${ORCHESTRATOR_TOKEN}` },
    });

    expect(res.status).toBe(403);
  });

  it("lets the orchestrator through with one", async () => {
    const res = await fetch(`${baseUrl}/corpora/${CORPUS}/search?q=deploy`, {
      headers: {
        authorization: `Bearer ${ORCHESTRATOR_TOKEN}`,
        [DELEGATED_TOKEN_HEADER]: DELEGATED,
      },
    });

    expect(res.status).toBe(200);
  });
});

/**
 * The Go engine cannot be driven from here, so its paths are read instead.
 *
 * Crude on purpose. The alternative to checking the string is not checking it,
 * and this exact string is what broke: `internal/corpus/broker.go` is the Go
 * twin of `BrokerProber` and has to agree with a server written in TypeScript,
 * with nothing between them but a convention nobody is reminded of.
 */
describe("the Go engine addresses the same routes", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const brokerGo = readFileSync(
    join(repoRoot, "orchestrator/engines/temporal/internal/corpus/broker.go"),
    "utf8",
  );

  it("probes /corpora/, not /connections/", () => {
    expect(brokerGo).toContain('"/corpora/"');
    // `/connections/` is webhooks only, and the Go prober never delivers one.
    expect(brokerGo).not.toContain('"/connections/"');
  });

  it("treats only 403 as a denial", () => {
    // StatusNotFound appearing beside StatusForbidden is how the silent drain
    // was written the first time.
    const denialLine = brokerGo
      .split("\n")
      .find((line) => line.includes("StatusForbidden"));
    expect(denialLine).toBeDefined();
    expect(denialLine).not.toContain("StatusNotFound");
  });
});

/**
 * Webhook delivery, end to end through the real server.
 *
 * The only entry point a STRANGER can reach: it is authenticated by the
 * provider's signature rather than by any token of ours, so the signature is
 * the whole boundary between the internet and a broker that spends a client's
 * credential on demand. Nothing else in this suite drives it.
 *
 * The fan-out is the other half. A provider signs and delivers per
 * integration, so one delivery reaches however many Corpora cover what
 * changed (ADR 0043 §4) — and must never reach a Corpus on a different
 * Connection, even when the channel id happens to match.
 */
describe("webhook delivery", () => {
  const SIGNING_SECRET = "e2e-webhook-secret";
  const CONNECTION = "bitovi-slack";

  /** Signed exactly as Slack signs, over the bytes as sent. */
  function sign(rawBody: string, timestamp = Math.floor(Date.now() / 1000)) {
    const mac = createHmac("sha256", SIGNING_SECRET)
      .update(`v0:${timestamp}:${rawBody}`, "utf8")
      .digest("hex");
    return {
      "x-slack-request-timestamp": String(timestamp),
      "x-slack-signature": `v0=${mac}`,
      "content-type": "application/json",
    };
  }

  /** Two Corpora over ONE Connection, plus one over another. */
  function slackServer(onChange: (corpus: string, ids: string[]) => void) {
    const driver = {
      provider: "slack",
      validateScope: () => {},
      list: vi.fn(),
      fetch: vi.fn(),
      probeGranularity: () => "connection" as const,
      probe: vi.fn(),
      parseWebhook: new SlackDriver({}).parseWebhook!.bind(new SlackDriver({})),
    };

    const corpus = (name: string, connection: string, channel: string) => ({
      name,
      connection,
      driver: driver as never,
      scope: { channel },
      allowedRoles: ["reader"],
      serviceToken: "bot",
    });

    return createBrokerServer({
      auth: { orchestratorToken: "orch", syncTokens: new Map() },
      registry: new StaticCorpusRegistry([
        corpus("eng-a", CONNECTION, "CENG"),
        corpus("eng-b", CONNECTION, "CENG"),
        corpus("leads", CONNECTION, "CLEADS"),
        // Same channel id, DIFFERENT Connection: a delivery signed by one
        // workspace must not reach another's corpus.
        corpus("other-workspace", "someone-else-slack", "CENG"),
      ]),
      webhooks: {
        secretFor: (connection) => (connection === CONNECTION ? SIGNING_SECRET : undefined),
        onChange,
      },
    });
  }

  let hookServer: Server;
  let hookUrl: string;
  let changes: { corpus: string; ids: string[] }[];

  beforeEach(async () => {
    changes = [];
    hookServer = slackServer((corpus, ids) => changes.push({ corpus, ids }));
    await new Promise<void>((resolve) => hookServer.listen(0, () => resolve()));
    hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/connections/${CONNECTION}/webhook`;
  });

  afterEach(() => hookServer?.close());

  const deliver = (body: unknown, headers?: Record<string, string>) => {
    const raw = JSON.stringify(body);
    return fetch(hookUrl, { method: "POST", headers: headers ?? sign(raw), body: raw });
  };

  const message = (channel: string) => ({
    type: "event_callback",
    event: { type: "message", channel, ts: "1700000001.000100" },
  });

  it("fans one delivery out to every Corpus covering that channel", async () => {
    const res = await deliver(message("CENG"));

    expect(res.status).toBe(202);
    expect(changes.map((c) => c.corpus).sort()).toEqual(["eng-a", "eng-b"]);
  });

  it("never crosses to a Corpus on a different Connection", async () => {
    // `other-workspace` scopes the SAME channel id. Routing by channel alone
    // would deliver another workspace's event into a client's corpus.
    await deliver(message("CENG"));

    expect(changes.map((c) => c.corpus)).not.toContain("other-workspace");
  });

  it("leaves Corpora covering another channel alone", async () => {
    await deliver(message("CLEADS"));

    expect(changes.map((c) => c.corpus)).toEqual(["leads"]);
  });

  it("refuses a forged signature", async () => {
    const raw = JSON.stringify(message("CENG"));
    const res = await fetch(hookUrl, {
      method: "POST",
      headers: {
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=0000000000000000000000000000000000000000000000000000000000000000",
        "content-type": "application/json",
      },
      body: raw,
    });

    expect(res.status).toBe(401);
    expect(changes).toEqual([]);
  });

  it("refuses a replayed delivery, however well signed", async () => {
    // A captured delivery is valid forever without this, and replaying it
    // makes the broker spend a client's credential on demand.
    const old = Math.floor(Date.now() / 1000) - 60 * 60;
    const raw = JSON.stringify(message("CENG"));

    const res = await fetch(hookUrl, { method: "POST", headers: sign(raw, old), body: raw });

    expect(res.status).toBe(401);
    expect(changes).toEqual([]);
  });

  it("refuses a body that was re-serialised after signing", async () => {
    // The signature covers BYTES. A proxy that reformats JSON breaks it, and
    // so does an attacker editing a captured payload.
    const raw = JSON.stringify(message("CENG"));
    const headers = sign(raw);

    const res = await fetch(hookUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(JSON.parse(raw)) + " ",
    });

    expect(res.status).toBe(401);
  });

  it("answers a URL-verification handshake without acting", async () => {
    const res = await deliver({ type: "url_verification", challenge: "abc" });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ acted: false });
    expect(changes).toEqual([]);
  });

  it("accepts an event about a channel nobody indexes", async () => {
    // The ORDINARY case — most events in a workspace concern channels no
    // Corpus covers. Erroring would make the provider disable the endpoint.
    const res = await deliver(message("CNOBODY"));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ acted: false });
  });

  it("is refused for a Connection with no signing secret", async () => {
    const raw = JSON.stringify(message("CENG"));
    const res = await fetch(
      hookUrl.replace(CONNECTION, "someone-else-slack"),
      { method: "POST", headers: sign(raw), body: raw },
    );

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(changes).toEqual([]);
  });
});
