import type { ToolDescriptor } from "../tool-descriptor.js";
import type { CitedSource } from "./cite.js";
import type { KnowledgeBaseExecMember } from "./exec.js";
import { refusalNote, type CorpusLookupOptions } from "./lookup.js";

/** How many items a recent call returns across all sources. PARITY: recentLimit. */
const RECENT_LIMIT = 10;

export type CorpusRecentOptions = CorpusLookupOptions;

export interface CorpusRecentResult {
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

/** One item, as the broker returns it. */
interface BrokerItem {
  id: string;
  title?: string;
  url?: string;
  updatedAt?: string;
  excerpt?: string;
}

/**
 * Lists the sources' newest items, LIVE and as the calling user.
 *
 * The recency counterpart of CorpusLookup, and live for the same reason: "what
 * is the latest message in #team-snc" is a question about NOW, which the index
 * cannot answer — it ranks by relevance, not time, and lags by a sync interval.
 * Each source orders by its own clock and this merges them newest first.
 *
 * PARITY: `RecentCorpus` in
 * `engines/temporal/internal/temporal/activities/corpus_recent.go`.
 */
export class CorpusRecent {
  constructor(private readonly options: CorpusRecentOptions) {}

  async recent(
    tool: ToolDescriptor,
    source: string,
    caller: { subject: string; roles: string[] },
    /** The citation number the first item takes: the turn's next unused one. */
    firstIndex = 1,
  ): Promise<CorpusRecentResult> {
    const exec = tool.knowledgeBaseExec;
    if (!exec || exec.operation !== "recent") {
      throw new Error(`tool ${tool.id} is not a knowledge-base recent`);
    }

    const members = membersNamed(exec.members, source);
    if (!members) {
      return {
        result:
          `"${source}" is not a source in ${exec.displayName}. Sources here: ` +
          `${exec.members.map((m) => `${m.id} (${m.label})`).join(", ")}.`,
      };
    }

    const items: (BrokerItem & { member: string; corpus: string })[] = [];
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

      const outcome = await this.recentThroughBroker(member, credential.token);
      if (outcome.note) {
        refused.push(`${member.label} (${outcome.note})`);
        continue;
      }
      asked += 1;
      for (const item of outcome.items) items.push({ ...item, member: member.label, corpus: member.id });
    }

    if (!anyMember) {
      return { result: `You do not have access to anything in ${exec.displayName}.` };
    }

    // Only ask for a link when nothing could be asked at all, as lookup does.
    if (asked === 0 && unlinked.length > 0) {
      return {
        needsLink: true,
        linkProviders: [...unlinkedProviders].sort(),
        result:
          `I need you to link the account behind ${unlinked.join(", ")} before I can ` +
          "check what is new — this runs as you, not as the ingestion credential.",
      };
    }

    const newest = newestFirst(items, RECENT_LIMIT);
    return {
      result: render(exec.displayName, source, firstIndex, newest, unlinked, refused),
      sources: newest.map((item, i) => ({ n: firstIndex + i, title: item.title ?? item.id, url: item.url ?? "" })),
    };
  }

  private async recentThroughBroker(
    member: KnowledgeBaseExecMember,
    delegated: string,
  ): Promise<{ items: BrokerItem[]; note?: string }> {
    const http = this.options.fetchImpl ?? fetch;
    const endpoint =
      `${this.options.brokerUrl.replace(/\/+$/, "")}` +
      `/corpora/${encodeURIComponent(member.id)}/recent?limit=${RECENT_LIMIT}`;

    let response: Response;
    try {
      response = await http(endpoint, {
        headers: {
          authorization: `Bearer ${this.options.brokerToken}`,
          "x-delegated-token": delegated,
        },
      });
    } catch (cause) {
      throw new Error(`connection-broker unreachable: ${String(cause)}`);
    }

    // This provider cannot list by time: that source contributes nothing here.
    if (response.status === 404) return { items: [], note: "cannot list recent items" };
    if (!response.ok) {
      return { items: [], note: refusalNote(response.status, await response.text().catch(() => "")) };
    }
    const body = (await response.json()) as { hits?: BrokerItem[] };
    return { items: body.hits ?? [] };
  }
}

/**
 * Narrows to the member a caller named, by id or display name, ignoring case
 * and a leading "#". Empty is every member; `undefined` means a name was given
 * and nothing answers to it — said, not silently widened to everything.
 */
function membersNamed(members: KnowledgeBaseExecMember[], name: string): KnowledgeBaseExecMember[] | undefined {
  const want = normalize(name);
  if (!want) return members;
  const match = members.find((m) => normalize(m.id) === want || normalize(m.label) === want);
  return match ? [match] : undefined;
}

const normalize = (s: string) => s.trim().toLowerCase().replace(/^#/, "");

/**
 * Newest first, at most `limit`. An item whose time cannot be parsed sorts last
 * rather than being dropped: it is still something the source returned.
 */
function newestFirst<T extends { updatedAt?: string }>(items: T[], limit: number): T[] {
  const time = (item: T) => {
    const t = item.updatedAt ? Date.parse(item.updatedAt) : Number.NaN;
    return Number.isNaN(t) ? -Infinity : t;
  };
  return [...items].sort((a, b) => time(b) - time(a)).slice(0, limit);
}

function render(
  displayName: string,
  source: string,
  firstIndex: number,
  items: (BrokerItem & { member: string; corpus: string })[],
  unlinked: string[],
  refused: string[],
): string {
  const where = source.trim() ? `${displayName} (${source.trim()})` : displayName;
  const parts: string[] = [];

  if (items.length === 0) {
    parts.push(`Nothing recent came back from ${where}.`);
  } else {
    parts.push(`Most recent in ${where}, newest first:`);
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

  if (unlinked.length > 0) parts.push(`\n\nNot checked (no linked account): ${unlinked.join(", ")}.`);
  if (refused.length > 0) parts.push(`\n\nCould not check: ${refused.join(", ")}.`);
  return parts.join("");
}
