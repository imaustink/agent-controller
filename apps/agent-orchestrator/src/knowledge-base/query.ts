import type { ToolDescriptor } from "../tool-descriptor.js";
import type { CitedSource } from "./cite.js";
import type { KnowledgeBaseExecMember } from "./exec.js";
import { refusalNote, type CorpusLookupOptions } from "./lookup.js";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

export type CorpusQueryOptions = CorpusLookupOptions;

/**
 * The provider-neutral filter the broker translates into each source's own query
 * language. PARITY: `SourceQuery` in apps/connection-broker/src/drivers/types.ts
 * and corpus_query.go.
 */
export interface SourceQuery {
  text?: string;
  title?: string;
  author?: string;
  after?: string;
  before?: string;
  type?: string;
  sort?: "relevance" | "newest" | "oldest";
  limit?: number;
}

/** What the planner writes: a SourceQuery plus which source. */
type PlannerQuery = SourceQuery & { source?: string };

export interface CorpusQueryResult {
  result: string;
  /** Set when NOTHING could be asked for want of a linked account. */
  needsLink?: boolean;
  /** Providers to link when `needsLink`; the graph starts the flow from these. */
  linkProviders?: string[];
  /**
   * The items, numbered from the `firstIndex` given, so an answer can cite them
   * inline. Each title and URL is the source's own answer to a request run AS
   * the caller, so it is theirs to see, like a probe's.
   */
  sources?: CitedSource[];
}

interface BrokerItem {
  id: string;
  title?: string;
  url?: string;
  updatedAt?: string;
  excerpt?: string;
}

type Item = BrokerItem & { member: string; corpus: string };

const FIELDS = new Set(["source", "text", "title", "author", "after", "before", "type", "sort", "limit"]);

/**
 * Answers a structured question about the sources' items, LIVE and as the
 * calling user: filter by keywords, title, author, date range and type; sort
 * newest, oldest or by relevance; optionally in one source.
 *
 * Live for the reasons the index cannot serve these: it ranks by relevance only,
 * its metadata is not queryable, and it lags by a sync interval. Each source
 * refuses a filter it cannot apply rather than silently ignoring it, and those
 * refusals are reported, never presented as matches.
 *
 * PARITY: `QueryCorpus` in
 * `engines/temporal/internal/temporal/activities/corpus_query.go`.
 */
export class CorpusQuery {
  constructor(private readonly options: CorpusQueryOptions) {}

  async query(
    tool: ToolDescriptor,
    input: string,
    caller: { subject: string; roles: string[] },
    /** The citation number the first item takes: the turn's next unused one. */
    firstIndex = 1,
  ): Promise<CorpusQueryResult> {
    const exec = tool.knowledgeBaseExec;
    if (!exec || exec.operation !== "query") {
      throw new Error(`tool ${tool.id} is not a knowledge-base query`);
    }

    const parsed = parsePlannerQuery(input);
    // Prose, not an error: the planner wrote the input and can correct it.
    if ("problem" in parsed) return { result: parsed.problem };
    const { source = "", ...filter } = parsed.query;

    const members = membersNamed(exec.members, source);
    if (!members) {
      return {
        result:
          `"${source}" is not a source in ${exec.displayName}. Sources here: ` +
          `${exec.members.map((m) => `${m.id} (${m.label})`).join(", ")}.`,
      };
    }

    const perSource: Item[][] = [];
    const unlinked: string[] = [];
    const unlinkedProviders = new Set<string>();
    const refused: string[] = [];
    let asked = 0;
    let anyMember = false;

    for (const member of members) {
      if (!member.allowedRoles.some((role) => caller.roles.includes(role))) continue;
      anyMember = true;

      const credential = await this.options.credentials.delegatedToken(
        caller.subject,
        member.identityProviders ?? [],
      );
      if (!credential?.token) {
        unlinked.push(member.label);
        for (const provider of member.identityProviders ?? []) unlinkedProviders.add(provider);
        continue;
      }

      const outcome = await this.queryThroughBroker(member, filter, credential.token);
      if (outcome.note) {
        refused.push(`${member.label} (${outcome.note})`);
        continue;
      }
      asked += 1;
      perSource.push(outcome.items.map((item) => ({ ...item, member: member.label, corpus: member.id })));
    }

    if (!anyMember) {
      return { result: `You do not have access to anything in ${exec.displayName}.` };
    }

    // Only ask for a link when nothing could be asked at all, as search does.
    if (asked === 0 && unlinked.length > 0) {
      return {
        needsLink: true,
        linkProviders: [...unlinkedProviders].sort(),
        result:
          `I need you to link the account behind ${unlinked.join(", ")} before I can ` +
          "query it — this runs as you, not as the ingestion credential.",
      };
    }

    const items = mergeResults(perSource, filter.sort!, filter.limit!);
    return {
      result: render(exec.displayName, parsed.query, firstIndex, items, unlinked, refused),
      sources: items.map((item, i) => ({ n: firstIndex + i, title: item.title ?? item.id, url: item.url ?? "" })),
    };
  }

  private async queryThroughBroker(
    member: KnowledgeBaseExecMember,
    filter: SourceQuery,
    delegated: string,
  ): Promise<{ items: BrokerItem[]; note?: string }> {
    const http = this.options.fetchImpl ?? fetch;
    const endpoint =
      `${this.options.brokerUrl.replace(/\/+$/, "")}` + `/corpora/${encodeURIComponent(member.id)}/query`;

    let response: Response;
    try {
      response = await http(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.brokerToken}`,
          "content-type": "application/json",
          "x-delegated-token": delegated,
        },
        body: JSON.stringify(filter),
      });
    } catch (cause) {
      throw new Error(`connection-broker unreachable: ${String(cause)}`);
    }

    if (response.status === 404) return { items: [], note: "cannot be queried this way" };
    if (!response.ok) {
      return { items: [], note: refusalNote(response.status, await response.text().catch(() => "")) };
    }
    const body = (await response.json()) as { hits?: BrokerItem[]; unsupported?: string[] };
    // Refused, not ignored: these results would not be what was asked for.
    if (body.unsupported?.length) return { items: [], note: `cannot filter by ${body.unsupported.join(", ")}` };
    return { items: body.hits ?? [] };
  }
}

/**
 * Reads the planner's input, applies the defaults, and validates it, returning
 * prose the planner can act on when it is not usable. Plain words, not JSON, are
 * taken as keywords. PARITY: parsePlannerQuery in corpus_query.go.
 */
export function parsePlannerQuery(raw: string): { query: PlannerQuery } | { problem: string } {
  const trimmed = raw.trim();
  let q: PlannerQuery = {};
  if (trimmed.startsWith("{")) {
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch (cause) {
      return { problem: unusable(String(cause)) };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) return { problem: unusable("not an object") };
    for (const [key, field] of Object.entries(value)) {
      if (!FIELDS.has(key)) return { problem: unusable(`unknown field "${key}"`) };
      if (key === "limit" ? typeof field !== "number" : typeof field !== "string") {
        return { problem: unusable(`"${key}" has the wrong type`) };
      }
    }
    q = value as PlannerQuery;
  } else if (trimmed) {
    q = { text: trimmed };
  }

  for (const name of ["after", "before"] as const) {
    const date = q[name];
    if (date && !isDate(date)) return { problem: `"${date}" is not a date for "${name}"; use YYYY-MM-DD.` };
  }
  if (q.sort === undefined || q.sort === ("" as never)) {
    q.sort = q.text ? "relevance" : "newest";
  } else if (!["relevance", "newest", "oldest"].includes(q.sort)) {
    return { problem: `"${q.sort}" is not a sort; use newest, oldest or relevance.` };
  } else if (q.sort === "relevance" && !q.text) {
    q.sort = "newest"; // nothing to be relevant to
  }
  if (q.limit !== undefined && q.limit < 0) return { problem: "limit must be positive." };
  q.limit = !q.limit ? DEFAULT_LIMIT : Math.min(q.limit, MAX_LIMIT);
  return { query: q };
}

const unusable = (why: string) =>
  `That query is not usable (${why}). Send a JSON object with any of: ` +
  "source, text, title, author, after, before, type, sort, limit.";

function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

/**
 * Narrows to the member a caller named, by id or display name, ignoring case and
 * a leading "#". Empty is every member; `undefined` means a name was given and
 * nothing answers to it — said, not silently widened to everything.
 */
function membersNamed(members: KnowledgeBaseExecMember[], name: string): KnowledgeBaseExecMember[] | undefined {
  const want = normalize(name);
  if (!want) return members;
  const match = members.find((m) => normalize(m.id) === want || normalize(m.label) === want);
  return match ? [match] : undefined;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/^#/, "");

/**
 * Combines each source's results into one list of at most `limit`. Time sorts
 * merge on each item's own clock; relevance interleaves sources in turn, because
 * one provider's score means nothing next to another's. PARITY: mergeQueryResults.
 */
function mergeResults(perSource: Item[][], sort: string, limit: number): Item[] {
  let merged: Item[] = [];
  if (sort === "relevance") {
    for (let i = 0; perSource.some((items) => i < items.length); i++) {
      for (const items of perSource) if (i < items.length) merged.push(items[i]!);
    }
  } else {
    const time = (item: Item) => {
      const t = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
      return Number.isNaN(t) ? undefined : t;
    };
    merged = perSource.flat().sort((a, b) => {
      const ta = time(a);
      const tb = time(b);
      if (ta === undefined || tb === undefined) return ta === undefined ? (tb === undefined ? 0 : 1) : -1;
      return sort === "oldest" ? ta - tb : tb - ta;
    });
  }
  return merged.slice(0, limit);
}

function describe(q: PlannerQuery): string {
  const parts: string[] = [];
  const add = (label: string, value?: string) => {
    if (value) parts.push(`${label} "${value}"`);
  };
  add("matching", q.text);
  add("titled", q.title);
  add("by", q.author);
  add("type", q.type);
  add("changed on or after", q.after);
  add("changed before", q.before);
  parts.push(q.sort === "relevance" ? "most relevant first" : `${q.sort} first`);
  return parts.join(", ");
}

function render(
  displayName: string,
  q: PlannerQuery,
  firstIndex: number,
  items: Item[],
  unlinked: string[],
  refused: string[],
): string {
  const where = q.source?.trim() ? `${displayName} (${q.source.trim()})` : displayName;
  const parts: string[] = [];

  if (items.length === 0) {
    parts.push(`Nothing in ${where} matches: ${describe(q)}.`);
  } else {
    parts.push(`Results from ${where} — ${describe(q)}:`);
    items.forEach((item, i) => {
      const lines = [
        `\n- [${firstIndex + i}] ${item.title ?? item.id} — ${item.member}` +
          (item.updatedAt ? ` · changed ${item.updatedAt}` : ""),
        `  reference: ${item.corpus}/${item.id}`,
      ];
      if (item.url) lines.push(`  ${item.url}`);
      if (item.excerpt) lines.push(`  ${item.excerpt.split(/\s+/).join(" ").trim()}`);
      parts.push(lines.join("\n"));
    });
  }

  if (unlinked.length > 0) parts.push(`\n\nNot queried (no linked account): ${unlinked.join(", ")}.`);
  if (refused.length > 0) parts.push(`\n\nCould not query: ${refused.join("; ")}.`);
  return parts.join("");
}
