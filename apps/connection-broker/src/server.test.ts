import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createBrokerServer, DELEGATED_TOKEN_HEADER } from "./server.js";
import { StaticConnectionRegistry } from "./registry.js";
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
        syncTokens: new Map([["snc-confluence", "sync"]]),
      },
      registry: new StaticConnectionRegistry([
        { name: "snc-confluence", driver: d, scope: { space: "SNC" }, serviceToken: "service-cred" },
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
    expect((await call("/connections/snc-confluence/resources")).status).toBe(401);
  });

  it("lets a sync worker list with the SERVICE credential", async () => {
    const res = await call("/connections/snc-confluence/resources", {
      headers: { authorization: "Bearer sync" },
    });

    expect(res.status).toBe(200);
    expect(driver.list).toHaveBeenCalledWith({ space: "SNC" }, { service: "service-cred" }, undefined);
  });

  it("refuses to let the orchestrator list", async () => {
    // Listing is ingestion; a request-path caller driving it would gain
    // corpus-wide enumeration under the ingestion credential.
    const res = await call("/connections/snc-confluence/resources", {
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user" },
    });

    expect(res.status).toBe(403);
    expect(driver.list).not.toHaveBeenCalled();
  });

  it("refuses an orchestrator fetch with no delegated token", async () => {
    const res = await call("/connections/snc-confluence/resources/1", {
      headers: { authorization: "Bearer orch" },
    });

    expect(res.status).toBe(403);
    expect(driver.fetch).not.toHaveBeenCalled();
  });

  it("passes ONLY the delegated token to the driver for an orchestrator read", async () => {
    await call("/connections/snc-confluence/resources/1", {
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "user-token" },
    });

    // The service credential must not be reachable from the request path at
    // all — not merely unused, but never handed over.
    expect(driver.fetch).toHaveBeenCalledWith({ space: "SNC" }, { delegated: "user-token" }, "1");
  });

  it("scopes a sync worker to its own connection", async () => {
    const res = await call("/connections/other/resources", {
      headers: { authorization: "Bearer sync" },
    });
    expect(res.status).toBe(403);
  });

  it("probes with the calling user's token", async () => {
    const res = await call("/connections/snc-confluence/probe", {
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
    expect(driver.probe).toHaveBeenCalledWith({ space: "SNC" }, { delegated: "user-token" }, "page-1");
  });

  it("maps a denial to 403 and a transient failure to 503, never the reverse", async () => {
    server.close();
    start(
      fakeDriver({
        probe: vi.fn().mockRejectedValue(new PermissionDeniedError("403 from source")),
      }),
    );
    const denied = await call("/connections/snc-confluence/probe", {
      method: "POST",
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "u" },
      body: "{}",
    });
    expect(denied.status).toBe(403);

    server.close();
    start(fakeDriver({ probe: vi.fn().mockRejectedValue(new TransientError("429")) }));
    const busy = await call("/connections/snc-confluence/probe", {
      method: "POST",
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "u" },
      body: "{}",
    });
    // A busy source must be distinguishable from a denial, or the caller
    // silently drops evidence it should have surfaced (ADR 0040).
    expect(busy.status).toBe(503);
  });

  it("404s an unknown connection", async () => {
    const res = await call("/connections/nope/resources", {
      headers: { authorization: "Bearer orch", [DELEGATED_TOKEN_HEADER]: "u" },
    });
    expect([403, 404]).toContain(res.status);
  });

  it("404s an unknown route", async () => {
    const res = await call("/connections/snc-confluence/secrets", {
      headers: { authorization: "Bearer orch" },
    });
    expect(res.status).toBe(404);
  });
});
