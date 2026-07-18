import type { AppConfig } from "./config.js";
import type { Query } from "./schema.js";

export class InvalidQueryError extends Error {}
export class SignozRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}

/** Parses "now" / "-15m" / "-1h" / "-24h" / an ISO-8601 timestamp into epoch ms. */
function resolveTimestamp(raw: string, now: number): number {
  if (raw === "now") return now;
  const relative = /^-(\d+)(s|m|h|d)$/.exec(raw);
  if (relative) {
    const amount = Number(relative[1]);
    const unitMs = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[relative[2] as string];
    return now - amount * (unitMs as number);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) {
    throw new InvalidQueryError(`Could not parse timestamp "${raw}" (use "now", "-15m", "-1h", "-24h", or ISO-8601).`);
  }
  return parsed;
}

export interface ResolvedRange {
  startMs: number;
  endMs: number;
}

export function resolveRange(query: Query, cfg: AppConfig, now: number): ResolvedRange {
  const startMs = resolveTimestamp(query.start, now);
  const endMs = resolveTimestamp(query.end, now);
  if (endMs <= startMs) {
    throw new InvalidQueryError(`"end" (${query.end}) must be after "start" (${query.start}).`);
  }
  if (endMs - startMs > cfg.maxLookbackMs) {
    throw new InvalidQueryError(
      `Requested window (${Math.round((endMs - startMs) / 60_000)}m) exceeds the max lookback of ${Math.round(cfg.maxLookbackMs / 60_000)}m.`,
    );
  }
  return { startMs, endMs };
}

const DATA_SOURCE: Record<Query["signal"], string> = {
  logs: "logs",
  traces: "traces",
  metrics: "metrics",
};

function filterItems(query: Query) {
  const items = (query.filters ?? []).map((f) => ({
    key: { key: f.key },
    op: f.op,
    value: f.value,
  }));
  if (query.serviceName) {
    items.push({
      key: { key: query.signal === "traces" ? "serviceName" : "service.name" },
      op: "=",
      value: query.serviceName,
    });
  }
  return items;
}

/**
 * Builds a SigNoz Query Service v3 `/api/v3/query_range` builder-mode
 * request body from the simplified {@link Query} contract. This targets the
 * common "list recent logs/traces" / "read a metric" shape; verify against
 * your SigNoz version if it rejects the payload (the v3 query API has
 * evolved across releases).
 */
export function buildQueryRangePayload(query: Query, range: ResolvedRange) {
  const limit = query.limit ?? 100;
  const builderQuery: Record<string, unknown> = {
    dataSource: DATA_SOURCE[query.signal],
    queryName: "A",
    expression: "A",
    disabled: false,
    filters: { op: "AND", items: filterItems(query) },
  };

  if (query.signal === "metrics") {
    builderQuery.aggregateOperator = "avg";
    builderQuery.aggregateAttribute = { key: query.metricName };
  } else {
    builderQuery.aggregateOperator = "noop";
    builderQuery.aggregateAttribute = {};
    builderQuery.limit = limit;
    builderQuery.orderBy = [{ columnName: "timestamp", order: "desc" }];
  }

  return {
    start: range.startMs,
    end: range.endMs,
    step: 60,
    compositeQuery: {
      queryType: "builder",
      panelType: query.signal === "metrics" ? "graph" : "list",
      builderQueries: { A: builderQuery },
    },
  };
}

export async function queryRange(
  cfg: AppConfig,
  payload: unknown,
  timeoutMs: number,
): Promise<unknown> {
  if (!cfg.signozBaseUrl) {
    throw new Error("SIGNOZ_BASE_URL is not configured.");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/api/v3/query_range", cfg.signozBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(cfg.signozApiKey ? { "SIGNOZ-API-KEY": cfg.signozApiKey } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new SignozRequestError(`SigNoz returned ${res.status}`, res.status, text);
    }
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}
