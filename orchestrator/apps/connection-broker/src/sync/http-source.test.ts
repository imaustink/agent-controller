import { describe, expect, it, vi } from "vitest";
import { HttpResourceSource, type FetchLike } from "./http-source.js";
import { PermanentError, PermissionDeniedError, TransientError } from "../drivers/types.js";
import { createBrokerServer } from "../server.js";
import { StaticCorpusRegistry } from "../registry.js";

const BASE = "http://broker.test";

function respond(status: number, body: unknown = {}, text?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => text ?? JSON.stringify(body),
  };
}

function source(fetchImpl: FetchLike, token = "sync-token") {
  return new HttpResourceSource({ baseUrl: `${BASE}/`, token, fetch: fetchImpl });
}

describe("list", () => {
  it("asks the broker for the connection's resources", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { resources: [{ id: "1" }], cursor: "c1" }));

    const page = await source(http).list("globex-confluence", undefined);

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/corpora/globex-confluence/resources`);
    expect(page).toEqual({ resources: [{ id: "1" }], cursor: "c1" });
  });

  it("carries the cursor, encoded", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { resources: [] }));
    await source(http).list("c", "ey+Jd/C9==");

    // The cursor is opaque and may contain anything; the broker decodes it.
    const [url] = http.mock.calls[0]!;
    expect(new URL(url).searchParams.get("cursor")).toBe("ey+Jd/C9==");
  });

  it("presents the worker's sync token", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { resources: [] }));
    await source(http, "per-connection-token").list("c", undefined);

    expect(http.mock.calls[0]![1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer per-connection-token" }),
      }),
    );
  });

  it("treats a missing resources array as empty rather than crashing", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, {}));
    expect(await source(http).list("c", undefined)).toEqual({ resources: [], cursor: undefined });
  });

  it("escapes a connection name into the path", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { resources: [] }));
    await source(http).list("weird/name", undefined);

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/corpora/weird%2Fname/resources`);
  });
});

describe("fetch", () => {
  it("requests one document by id", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { id: "12345", markdown: "hi" }));

    const doc = await source(http).fetch("c", "12345");

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/corpora/c/resources/12345`);
    expect(doc.markdown).toBe("hi");
  });

  it("escapes an id that would otherwise escape the path", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, {}));
    await source(http).fetch("c", "../../admin");

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/corpora/c/resources/..%2F..%2Fadmin`);
  });
});

describe("error classification", () => {
  it("maps 403 to a denial, which is a real drop", async () => {
    const http = vi.fn().mockResolvedValue(respond(403, {}, '{"error":"confluence returned 404"}'));
    await expect(source(http).fetch("c", "1")).rejects.toBeInstanceOf(PermissionDeniedError);
  });

  it("maps 503 to transient, so a reconcile may not delete on it", async () => {
    const http = vi.fn().mockResolvedValue(respond(503));
    await expect(source(http).fetch("c", "1")).rejects.toBeInstanceOf(TransientError);
  });

  it("maps 401 to PERMANENT, not to a denial", async () => {
    const http = vi.fn().mockResolvedValue(respond(401, {}, "unrecognized bearer token"));

    // A rejected worker token is not "this resource is inaccessible". Reading
    // it that way would let a misconfigured worker reconcile a corpus to empty
    // while every single fetch "succeeded" in being refused.
    await expect(source(http).fetch("c", "1")).rejects.toBeInstanceOf(PermanentError);
  });

  it("maps 500 to permanent", async () => {
    const http = vi.fn().mockResolvedValue(respond(500));
    await expect(source(http).fetch("c", "1")).rejects.toBeInstanceOf(PermanentError);
  });

  it("treats an unreachable broker as transient", async () => {
    const http = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));

    // The broker being down says nothing about the resource.
    await expect(source(http).fetch("c", "1")).rejects.toBeInstanceOf(TransientError);
  });

  it("carries the broker's explanation into the error", async () => {
    const http = vi.fn().mockResolvedValue(respond(403, {}, '{"error":"page 9 is in space OTHER"}'));
    await expect(source(http).fetch("c", "9")).rejects.toThrow(/space OTHER/);
  });
});

describe("the URL this client builds is one the SERVER serves", () => {
  // These assertions used to pin `/connections/:name/resources`, which is what
  // the client built — so both sides came from the same assumption and nothing
  // tied them together. When Connection was split into Connection and Corpus
  // (docs/adr/0043) the routes moved to `/corpora/` and this client did not,
  // and every test still passed while the sync path could not list or fetch
  // anything at all. It took an end-to-end run to notice.
  //
  // So this talks to a REAL broker server. It cannot pass if the two disagree.
  it("lists and fetches against a real broker server", async () => {
    const driver = {
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
      probe: vi.fn(),
    };

    const server = createBrokerServer({
      auth: { orchestratorToken: "orch", syncTokens: new Map([["globex-confluence", "sync"]]) },
      registry: new StaticCorpusRegistry([
        {
          name: "globex-confluence",
          driver: driver as never,
          scope: { space: "GLOBEX" },
          serviceToken: "service-cred",
        },
      ]),
    });
    await new Promise<void>((resolve) => server.listen(0, () => resolve()));
    const port = (server.address() as { port: number }).port;

    try {
      const source = new HttpResourceSource({
        baseUrl: `http://127.0.0.1:${port}`,
        token: "sync",
      });

      const page = await source.list("globex-confluence", undefined);
      expect(page.resources.map((r) => r.id)).toEqual(["1"]);

      const doc = await source.fetch("globex-confluence", "1");
      expect(doc.markdown).toBe("body");
    } finally {
      server.close();
    }
  });
});
