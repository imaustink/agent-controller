import type { SourceQuery } from "./types.js";

/**
 * The provider-neutral half of `Driver.queryAsUser`: validating an untrusted
 * query, and the defaults every driver must agree on.
 *
 * Shared rather than re-derived per driver because the defaults ARE the
 * contract — "no text means newest first" answered differently by two
 * providers would make one merged answer disagree with itself.
 */

export const QUERY_DEFAULT_LIMIT = 10;
export const QUERY_MAX_LIMIT = 25;

export type QuerySort = "relevance" | "newest" | "oldest";

const SORTS: ReadonlySet<string> = new Set<QuerySort>(["relevance", "newest", "oldest"]);
const STRING_FIELDS = ["text", "title", "author", "after", "before", "type"] as const;
const KNOWN_FIELDS: ReadonlySet<string> = new Set([...STRING_FIELDS, "sort", "limit"]);

/** The caller's query is malformed — a 400, not an answer from the source. */
export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueryValidationError";
  }
}

/** A real calendar date in YYYY-MM-DD form; "2026-02-30" is not one. */
export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * Validates an untrusted request body into a `SourceQuery`.
 *
 * Strict on purpose. An unknown field is rejected rather than ignored, for the
 * same reason a driver refuses a filter it cannot apply: a caller who sent
 * `space: "OTHER"` and got an answer would believe it had been honoured.
 * `null` is read as absent — tool-calling models send it for "not set".
 */
export function parseSourceQuery(body: unknown): SourceQuery {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new QueryValidationError("query body must be a JSON object");
  }
  const raw = body as Record<string, unknown>;

  const unknown = Object.keys(raw).filter((key) => !KNOWN_FIELDS.has(key));
  if (unknown.length > 0) {
    throw new QueryValidationError(`unknown query field(s): ${unknown.join(", ")}`);
  }

  const query: SourceQuery = {};
  for (const field of STRING_FIELDS) {
    const value = raw[field];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string") throw new QueryValidationError(`${field} must be a string`);
    query[field] = value;
  }

  for (const field of ["after", "before"] as const) {
    const value = query[field]?.trim();
    if (value && !isCalendarDate(value)) {
      throw new QueryValidationError(`${field} must be a date in YYYY-MM-DD form`);
    }
  }

  if (raw.sort !== undefined && raw.sort !== null) {
    if (typeof raw.sort !== "string" || !SORTS.has(raw.sort)) {
      throw new QueryValidationError(`sort must be one of: ${[...SORTS].join(", ")}`);
    }
    query.sort = raw.sort as QuerySort;
  }

  if (raw.limit !== undefined && raw.limit !== null) {
    if (typeof raw.limit !== "number" || !Number.isInteger(raw.limit) || raw.limit <= 0) {
      throw new QueryValidationError("limit must be a positive integer");
    }
    query.limit = raw.limit;
  }

  return query;
}

/** A query with every default applied, as drivers consume it. */
export interface ResolvedQuery {
  text?: string;
  title?: string;
  author?: string;
  after?: string;
  before?: string;
  type?: string;
  sort: QuerySort;
  limit: number;
}

/**
 * Applies the contract's defaults: strings trimmed (blank means absent), type
 * lower-cased, dates checked, sort and limit resolved.
 *
 * Drivers call this rather than trusting the route to have validated, because
 * a driver is also called directly — and a date that reaches a query language
 * unchecked is an injection, not a typo.
 */
export function resolveQuery(query: SourceQuery): ResolvedQuery {
  const clean = (value: string | undefined) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  };

  const resolved: ResolvedQuery = {
    text: clean(query.text),
    title: clean(query.title),
    author: clean(query.author),
    after: clean(query.after),
    before: clean(query.before),
    type: clean(query.type)?.toLowerCase(),
    sort: "newest",
    limit: QUERY_DEFAULT_LIMIT,
  };

  for (const field of ["after", "before"] as const) {
    const value = resolved[field];
    if (value !== undefined && !isCalendarDate(value)) {
      throw new QueryValidationError(`${field} must be a date in YYYY-MM-DD form, got ${JSON.stringify(value)}`);
    }
  }

  // "relevance" means nothing without words to be relevant to.
  const requested = query.sort ?? (resolved.text ? "relevance" : "newest");
  resolved.sort = requested === "relevance" && !resolved.text ? "newest" : requested;

  const limit = query.limit;
  resolved.limit =
    typeof limit === "number" && Number.isFinite(limit) && limit >= 1
      ? Math.min(Math.floor(limit), QUERY_MAX_LIMIT)
      : QUERY_DEFAULT_LIMIT;

  return resolved;
}
