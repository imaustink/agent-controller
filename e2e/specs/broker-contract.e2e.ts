import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createBrokerServer, DELEGATED_TOKEN_HEADER } from "../../apps/connection-broker/src/server.js";
import { StaticCorpusRegistry } from "../../apps/connection-broker/src/registry.js";
import { HttpResourceSource } from "../../apps/connection-broker/src/sync/http-source.js";
import { BrokerProber } from "../../apps/agent-orchestrator/src/knowledge-base/retrieve.js";
import { CorpusReader } from "../../apps/agent-orchestrator/src/knowledge-base/reader.js";
import { CorpusLookup } from "../../apps/agent-orchestrator/src/knowledge-base/lookup.js";

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
    join(repoRoot, "engines/temporal/internal/corpus/broker.go"),
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
