import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createBrokerServer, DELEGATED_TOKEN_HEADER } from "./server.js";
import { StaticCorpusRegistry } from "./registry.js";
import {
  PermissionDeniedError,
  TransientError,
  type Driver,
  type ProbeGranularity,
} from "./drivers/types.js";

function fakeDriver(overrides: Partial<Driver> = {}): Driver {
  return {
    provider: "confluence",
    validateScope: () => {},
    list: vi.fn().mockResolvedValue({ resources: [{ id: "1", title: "t", url: "u" }], cursor: undefined }),
    fetch: vi.fn().mockResolvedValue({ id: "1", title: "t", url: "u", markdown: "body" }),
    probeGranularity: (): ProbeGranularity => "resource",
    probe: vi.fn().mockResolvedValue({ allowed: true, title: "t", url: "u", version: "v1" }),
    ...overrides,
  };
}

describe("broker server", () => {
  let server: Server;
  let base: string;
  let driver: Driver;

  const start = (d: Driver = fakeDriver()): void => {
    driver = d;
    server = createBrokerServer({
      auth: {
        orchestratorToken: "orch",
        syncTokens: new Map([["globex-confluence", "sync"]]),
      },
      registry: new StaticCorpusRegistry([
        { name: "globex-confluence", driver: d, scope: { space: "GLOBEX" }, serviceToken: "service-cred" },
      ]),
    });
    server.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };

  beforeEach(() => start());
  afterEach(() => server.close());

  const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, init);

  it("serves health without a token", async () => {
    expect((await call("/healthz")).status).toBe(200);
  });

  it("rejects an unauthenticated caller", async () => {
    expect((await call("/corpora/globex-confluence/resources")).status).toBe(401);
  });

  it("lets a sync worker list with the SERVICE credential", async () => {
    const res = await call("/corpora/globex-confluence/resources", {
      headers: { authorization: "Bearer sync" },
    });

    expect(res.status).toBe(200);
    expect(driver.list).toHaveBeenCalledWith({ space: "GLOBEX" }, { service: "service-cred" }, undefined);
  });

  it("refuses to let the orchestrator list", async () => {
    // Listing is ingestion; a request-path caller driving it would gain
    // corpus-wide enumeration under the ingestion credential.
    const res = await call("/corpora/globex-confluence/resources", {
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" },
    });

    expect(res.status).toBe(403);
    expect(driver.list).not.toHaveBeenCalled();
  });

  it("refuses an orchestrator fetch with no delegated token", async () => {
    const res = await call("/corpora/globex-confluence/resources/1", {
      headers: { authorization: "Bearer orch" },
    });

    expect(res.status).toBe(403);
    expect(driver.fetch).not.toHaveBeenCalled();
  });

  it("passes ONLY the delegated token to the driver for an orchestrator read", async () => {
    await call("/corpora/globex-confluence/resources/1", {
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user-token" },
    });

    // The service credential must not be reachable from the request path at
    // all — not merely unused, but never handed over.
    expect(driver.fetch).toHaveBeenCalledWith({ space: "GLOBEX" }, { delegated: "user-token" }, "1");
  });

  it("scopes a sync worker to its own connection", async () => {
    const res = await call("/corpora/other/resources", {
      headers: { authorization: "Bearer sync" },
    });
    expect(res.status).toBe(403);
  });

  it("probes with the calling user's token", async () => {
    const res = await call("/corpora/globex-confluence/probe", {
      method: "POST",
      headers: {
        authorization: "Bearer orch",
        [DELEGATED_TOKEN_HEADER]: "user-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ sourceId: "page-1" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true, title: "t", url: "u", version: "v1" });
    expect(driver.probe).toHaveBeenCalledWith({ space: "GLOBEX" }, { delegated: "user-token" }, "page-1");
  });

  it("maps a denial to 403 and a transient failure to 503, never the reverse", async () => {
    server.close();
    start(
      fakeDriver({
        probe: vi.fn().mockRejectedValue(new PermissionDeniedError("403 from source")),
      }),
    );
    const denied = await call("/corpora/globex-confluence/probe", {
      method: "POST",
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "u" },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    server.close();
    start(fakeDriver({ probe: vi.fn().mockRejectedValue(new TransientError("429")) }));
    const busy = await call("/corpora/globex-confluence/probe", {
      method: "POST",
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "u" },
      body: "{}",
    });
    // A busy source must be distinguishable from a denial, or the caller
    // silently drops evidence it should have surfaced (ADR 0040).
    expect(busy.status).toBe(503);
  });

  it("404s an unknown connection", async () => {
    const res = await call("/corpora/nope/resources", {
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "u" },
    });
    expect([403, 404]).toContain(res.status);
  });

  it("404s an unknown route", async () => {
    const res = await call("/corpora/globex-confluence/secrets", {
      headers: { authorization: "Bearer orch" },
    });
    expect(res.status).toBe(404);
  });

  describe("live search", () => {
    const searching = () =>
      fakeDriver({
        searchAsUser: vi.fn().mockResolvedValue([
          { id: "9", title: "Runbook", url: "https://wiki/9", excerpt: "deploy steps" },
        ]),
      });

    it("searches with the caller's token, bounded by the corpus scope", async () => {
      start(searching());

      const res = await call("/corpora/globex-confluence/search?q=deploy", {
        headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" },
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        hits: [{ id: "9", title: "Runbook", url: "https://wiki/9", excerpt: "deploy steps" }],
      });
      // Both bounds, in one call: the delegated credential and the scope.
      expect(driver.searchAsUser).toHaveBeenCalledWith(
        { delegated: "user" },
        { space: "GLOBEX" },
        "deploy",
        10,
      );
    });

    it("never reaches the ingestion credential", async () => {
      // A search runs on the caller's behalf. Authorizing it as a fetch is
      // what stops a sync worker — which has no user — from driving it.
      start(searching());

      const res = await call("/corpora/globex-confluence/search?q=deploy", {
        headers: { authorization: "Bearer sync" },
      });

      expect(res.status).toBe(403);
      expect(driver.searchAsUser).not.toHaveBeenCalled();
    });

    it("refuses an orchestrator search with no delegated token", async () => {
      start(searching());

      const res = await call("/corpora/globex-confluence/search?q=deploy", {
        headers: { authorization: "Bearer orch" },
      });

      expect(res.status).toBe(403);
      expect(driver.searchAsUser).not.toHaveBeenCalled();
    });

    it("caps the limit a caller can ask for", async () => {
      start(searching());

      await call("/corpora/globex-confluence/search?q=deploy&limit=5000", {
        headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" },
      });

      expect(driver.searchAsUser).toHaveBeenCalledWith(expect.anything(), expect.anything(), "deploy", 25);
    });

    it("falls back to the default for a nonsense limit", async () => {
      start(searching());

      await call("/corpora/globex-confluence/search?q=deploy&limit=abc", {
        headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" },
      });

      expect(driver.searchAsUser).toHaveBeenCalledWith(expect.anything(), expect.anything(), "deploy", 10);
    });

    it("says so when the provider has no live search", async () => {
      // Optional on the interface: a provider whose search needs a scope or
      // token type we do not hold keeps vector search and nothing breaks.
      start(fakeDriver());

      const res = await call("/corpora/globex-confluence/search?q=deploy", {
        headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" },
      });

      expect(res.status).toBe(404);
      expect((await res.json()).error).toMatch(/no live search/);
    });
  });

  describe("structured query", () => {
    const HIT = { id: "9", title: "Runbook", url: "https://wiki/9", updatedAt: "2026-10-01T12:00:00.000Z" };
    const querying = (result: unknown = { hits: [HIT] }) =>
      fakeDriver({ queryAsUser: vi.fn().mockResolvedValue(result) });
    const USER = { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" };

    const post = (body: unknown, headers: Record<string, string> = USER) =>
      call("/corpora/globex-confluence/query", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      });

    it("runs the query with the caller's token, bounded by the corpus scope", async () => {
      start(querying());

      const res = await post({ author: "Ana Lopez", after: "2026-09-01", sort: "newest", limit: 3 });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hits: [HIT] });
      expect(driver.queryAsUser).toHaveBeenCalledWith(
        { delegated: "user" },
        { space: "GLOBEX" },
        { author: "Ana Lopez", after: "2026-09-01", sort: "newest", limit: 3 },
      );
    });

    it("passes the driver's refusal through, unsupported filters and all", async () => {
      start(querying({ hits: [], unsupported: ["title"] }));

      const res = await post({ title: "Runbook" });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ hits: [], unsupported: ["title"] });
    });

    it("defaults and caps the limit", async () => {
      start(querying());

      await post({});
      await post({ limit: 5000 });
      await post("");

      expect(
        (driver.queryAsUser as ReturnType<typeof vi.fn>).mock.calls.map((c) => (c[2] as { limit: number }).limit),
      ).toEqual([10, 25, 10]);
    });

    it.each([
      ["a non-object body", [1, 2]],
      ["a scalar body", "42"],
      ["malformed JSON", "{not json"],
      ["a non-string field", { author: 7 }],
      ["a date in the wrong form", { after: "10/01/2026" }],
      ["a date that is not on the calendar", { before: "2026-02-30" }],
      ["an unknown sort", { sort: "popular" }],
      ["a fractional limit", { limit: 2.5 }],
      ["a zero limit", { limit: 0 }],
      ["a string limit", { limit: "5" }],
      ["an unknown field", { space: "OTHER" }],
    ])("400s %s before the driver sees it", async (_label, body) => {
      start(querying());

      const res = await post(body);

      expect(res.status).toBe(400);
      expect(typeof (await res.json()).error).toBe("string");
      expect(driver.queryAsUser).not.toHaveBeenCalled();
    });

    it("refuses a GET, which would carry no filters", async () => {
      start(querying());

      const res = await call("/corpora/globex-confluence/query", { headers: USER });

      expect(res.status).toBe(405);
      expect(driver.queryAsUser).not.toHaveBeenCalled();
    });

    it("never reaches the ingestion credential", async () => {
      // A sync worker would otherwise authorize as a fetch and arrive holding
      // the service credential; the route refuses it before the driver.
      start(querying());

      const res = await post({}, { authorization: "Bearer sync" });

      expect(res.status).toBe(403);
      expect(driver.queryAsUser).not.toHaveBeenCalled();
    });

    it("refuses an orchestrator request with no delegated token", async () => {
      start(querying());

      const res = await post({}, { authorization: "Bearer orch" });

      expect(res.status).toBe(403);
      expect(driver.queryAsUser).not.toHaveBeenCalled();
    });

    it("says so when the provider has no structured query", async () => {
      start(fakeDriver());

      const res = await post({});

      expect(res.status).toBe(404);
      expect((await res.json()).error).toBe("confluence has no structured query");
    });

    it("maps a driver denial to 403", async () => {
      start(fakeDriver({ queryAsUser: vi.fn().mockRejectedValue(new PermissionDeniedError("no")) }));

      const res = await post({});

      expect(res.status).toBe(403);
    });
  });

  it("refuses a SYNC worker the user-read route", async () => {
    // A sync worker passes the fetch check — fetch is a legitimate ingestion
    // operation — and would arrive holding the service credential. The route
    // refuses it rather than leaving the driver to notice.
    start(fakeDriver({ readAsUser: vi.fn().mockResolvedValue({ id: "1", markdown: "b" }) }));

    const res = await call("/corpora/globex-confluence/documents/1", {
      headers: { authorization: "Bearer sync" },
    });

    expect(res.status).toBe(403);
    expect(driver.readAsUser).not.toHaveBeenCalled();
  });

});
