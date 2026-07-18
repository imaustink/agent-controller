import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { QuerySchema } from "./schema.js";
import { buildQueryRangePayload, InvalidQueryError, resolveRange } from "./signoz.js";

const cfg: AppConfig = {
  transport: "stdout",
  jobId: "test",
  eventsPath: "/tmp/x",
  callbackUrl: undefined,
  callbackSecret: undefined,
  callbackAllowedHosts: [],
  callbackMaxRetries: 3,
  natsUrl: undefined,
  natsSubject: undefined,
  signozBaseUrl: "http://signoz.example",
  signozApiKey: undefined,
  maxLookbackMs: 24 * 60 * 60 * 1000,
  fetchTimeoutMs: 15_000,
};

const NOW = Date.parse("2026-07-17T12:00:00.000Z");

describe("resolveRange", () => {
  it("resolves relative start/end", () => {
    const q = QuerySchema.parse({ signal: "logs", start: "-1h", end: "now" });
    const range = resolveRange(q, cfg, NOW);
    expect(range.endMs).toBe(NOW);
    expect(range.startMs).toBe(NOW - 3_600_000);
  });

  it("resolves absolute ISO timestamps", () => {
    const q = QuerySchema.parse({
      signal: "logs",
      start: "2026-07-17T11:00:00.000Z",
      end: "2026-07-17T11:30:00.000Z",
    });
    const range = resolveRange(q, cfg, NOW);
    expect(range.startMs).toBe(Date.parse("2026-07-17T11:00:00.000Z"));
    expect(range.endMs).toBe(Date.parse("2026-07-17T11:30:00.000Z"));
  });

  it("rejects end before start", () => {
    const q = QuerySchema.parse({ signal: "logs", start: "now", end: "-1h" });
    expect(() => resolveRange(q, cfg, NOW)).toThrow(InvalidQueryError);
  });

  it("rejects a window exceeding maxLookbackMs", () => {
    const q = QuerySchema.parse({ signal: "logs", start: "-25h", end: "now" });
    expect(() => resolveRange(q, cfg, NOW)).toThrow(InvalidQueryError);
  });

  it("rejects an unparseable timestamp", () => {
    const q = QuerySchema.parse({ signal: "logs", start: "yesterday", end: "now" });
    expect(() => resolveRange(q, cfg, NOW)).toThrow(InvalidQueryError);
  });
});

describe("buildQueryRangePayload", () => {
  it("builds a logs list query with the service filter merged in", () => {
    const q = QuerySchema.parse({
      signal: "logs",
      start: "-1h",
      end: "now",
      serviceName: "checkout",
      filters: [{ key: "severity_text", op: "=", value: "ERROR" }],
      limit: 25,
    });
    const range = resolveRange(q, cfg, NOW);
    const payload = buildQueryRangePayload(q, range) as any;
    expect(payload.compositeQuery.panelType).toBe("list");
    const builder = payload.compositeQuery.builderQueries.A;
    expect(builder.dataSource).toBe("logs");
    expect(builder.limit).toBe(25);
    expect(builder.filters.items).toHaveLength(2);
    expect(builder.filters.items[1]).toEqual({ key: { key: "service.name" }, op: "=", value: "checkout" });
  });

  it("requires metricName for metrics signal", () => {
    expect(() => QuerySchema.parse({ signal: "metrics", start: "-1h", end: "now" })).toThrow();
  });

  it("builds a metrics graph query", () => {
    const q = QuerySchema.parse({
      signal: "metrics",
      start: "-1h",
      end: "now",
      metricName: "http_requests_total",
    });
    const range = resolveRange(q, cfg, NOW);
    const payload = buildQueryRangePayload(q, range) as any;
    expect(payload.compositeQuery.panelType).toBe("graph");
    expect(payload.compositeQuery.builderQueries.A.aggregateAttribute).toEqual({ key: "http_requests_total" });
  });
});
