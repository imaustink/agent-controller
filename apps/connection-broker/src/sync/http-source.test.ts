import { describe, expect, it, vi } from "vitest";
import { HttpResourceSource, type FetchLike } from "./http-source.js";
import { PermanentError, PermissionDeniedError, TransientError } from "../drivers/types.js";

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

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/connections/globex-confluence/resources`);
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

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/connections/weird%2Fname/resources`);
  });
});

describe("fetch", () => {
  it("requests one document by id", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, { id: "12345", markdown: "hi" }));

    const doc = await source(http).fetch("c", "12345");

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/connections/c/resources/12345`);
    expect(doc.markdown).toBe("hi");
  });

  it("escapes an id that would otherwise escape the path", async () => {
    const http = vi.fn().mockResolvedValue(respond(200, {}));
    await source(http).fetch("c", "../../admin");

    expect(http.mock.calls[0]![0]).toBe(`${BASE}/connections/c/resources/..%2F..%2Fadmin`);
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
