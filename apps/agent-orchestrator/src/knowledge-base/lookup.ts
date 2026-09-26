import type { ToolDescriptor } from "../tool-descriptor.js";
import type { DelegatedCredentialResolver } from "./searcher.js";
import type { KnowledgeBaseExecMember } from "./exec.js";

export interface CorpusLookupOptions {
  /** Base URL of the connection-broker Service. */
  brokerUrl: string;
  /** Authenticates THIS orchestrator to the broker. */
  brokerToken: string;
  credentials: DelegatedCredentialResolver;
  fetchImpl?: typeof fetch;
}

export interface CorpusLookupResult {
  result: string;
  /** Set when NOTHING could be searched for want of a linked account. */
  needsLink?: boolean;
}

/** One hit, as the broker returns it. */
interface BrokerHit {
  id: string;
  title?: string;
  url?: string;
  excerpt?: string;
}

/**
 * Searches the SOURCES live, as the calling user.
 *
 * The complement to the indexed search rather than a replacement. The index
 * answers "what do we know about X" over a snapshot and is fast, ranked and
 * semantic; this answers "what is there NOW", which a stale snapshot cannot,
 * and is lexical because that is what the providers offer. A page written this
 * morning is invisible to the first and findable by the second.
 *
 * Bounded BOTH ways: by the corpus's scope and by who is asking. That is the
 * deliberate asymmetry with CorpusReader, which is bounded by identity alone —
 * a read follows a citation the caller already has, so it may leave the scope;
 * a search has no such anchor, and an unbounded one would turn "what does this
 * knowledge base know" into "everything this person can see anywhere".
 *
 * Fans out across members because a knowledge base is a composition: the
 * question is asked of the whole thing, and which source answers it is not
 * something the caller should have to know.
 *
 * PARITY: `LookupCorpus` in
 * `engines/temporal/internal/temporal/activities/corpus_lookup.go`.
 */
export class CorpusLookup {
  constructor(private readonly options: CorpusLookupOptions) {}

  async lookup(
    tool: ToolDescriptor,
    query: string,
    caller: { subject: string; roles: string[] },
  ): Promise<CorpusLookupResult> {
    const exec = tool.knowledgeBaseExec;
    if (!exec || exec.operation !== "lookup") {
      throw new Error(`tool ${tool.id} is not a knowledge-base lookup`);
    }

    const trimmed = query.trim();
    if (trimmed.length === 0) {
      return {
        result: "Give me something to look for — this searches the sources for words you name.",
      };
    }

    const hits: (BrokerHit & { member: string; corpus: string })[] = [];
    const unlinked: string[] = [];
    const refused: string[] = [];
    let searched = 0;
    let anyMember = false;

    for (const member of exec.members) {
      // Union to INVOKE, per member to SEARCH: the same split the read path
      // uses, and the same reason. `allowedRoles` is OUR policy layer, not the
      // source's — a caller whose account can see a space may still not reach
      // it through a corpus the operator scoped to other roles.
      if (!member.allowedRoles.some((role) => caller.roles.includes(role))) continue;
      anyMember = true;

      const credential = await this.options.credentials.delegatedToken(
        caller.subject,
        member.identityProviders ?? [],
      );
      if (!credential?.token) {
        unlinked.push(member.label);
        continue;
      }

      const outcome = await this.searchThroughBroker(member, trimmed, credential.token);
      if (outcome.note) {
        // Reported, not fatal: the other members still have answers, and
        // silently dropping one would make the result look complete.
        refused.push(`${member.label} (${outcome.note})`);
        continue;
      }
      searched += 1;
      for (const hit of outcome.hits) {
        hits.push({ ...hit, member: member.label, corpus: member.id });
      }
    }

    if (!anyMember) {
      return { result: `You do not have access to anything in ${exec.displayName}.` };
    }

    // Only ask for a link when nothing could be searched at all. Asking while
    // two of three members answered would interrupt a turn that succeeded.
    if (searched === 0 && unlinked.length > 0) {
      return {
        needsLink: true,
        result:
          `I need you to link the account behind ${unlinked.join(", ")} before I can ` +
          "search it live — this runs as you, not as the ingestion credential.",
      };
    }

    return { result: render(exec.displayName, trimmed, hits, unlinked, refused) };
  }

  /**
   * Performs the search, carrying the caller's own token.
   *
   * Returns a note instead of throwing when the source refused: like a refused
   * read, that is an ANSWER the model can act on, where an exception ends the
   * turn.
   */
  private async searchThroughBroker(
    member: KnowledgeBaseExecMember,
    query: string,
    delegated: string,
  ): Promise<{ hits: BrokerHit[]; note?: string }> {
    const http = this.options.fetchImpl ?? fetch;
    const endpoint =
      `${this.options.brokerUrl.replace(/\/+$/, "")}` +
      `/corpora/${encodeURIComponent(member.id)}/search?q=${encodeURIComponent(query)}`;

    let response: Response;
    try {
      response = await http(endpoint, {
        headers: {
          authorization: `Bearer ${this.options.brokerToken}`,
          "x-delegated-token": delegated,
        },
      });
    } catch (cause) {
      // Distinct from a refusal: we did not get an answer, and reporting one
      // would be inventing it.
      throw new Error(`connection-broker unreachable: ${String(cause)}`);
    }

    if (response.status === 404) {
      // This provider has no live search — Slack without `search:read`, or a
      // driver that never implemented it. That corpus simply contributes
      // nothing here and keeps its indexed passages.
      return { hits: [], note: "no live search for this source" };
    }
    if (!response.ok) {
      return { hits: [], note: `refused (${response.status})` };
    }

    const body = (await response.json()) as { hits?: BrokerHit[] };
    return { hits: body.hits ?? [] };
  }
}

/**
 * Turns hits into something a model can act on.
 *
 * Every hit is printed with `<corpus>/<id>`, which is exactly what the read
 * tool takes. That pairing is the point: a lookup finds the current document
 * and hands back a reference that reads it, without the model assembling one.
 */
function render(
  displayName: string,
  query: string,
  hits: (BrokerHit & { member: string; corpus: string })[],
  unlinked: string[],
  refused: string[],
): string {
  const parts: string[] = [];

  if (hits.length === 0) {
    parts.push(`Nothing in ${displayName} matches "${query}" right now.`);
  } else {
    parts.push(`Live results from ${displayName} for "${query}":`);
    for (const hit of hits) {
      const lines = [`\n- ${hit.title ?? hit.id} — ${hit.member}`];
      lines.push(`  reference: ${hit.corpus}/${hit.id}`);
      if (hit.url) lines.push(`  ${hit.url}`);
      if (hit.excerpt) lines.push(`  ${hit.excerpt.split(/\s+/).join(" ").trim()}`);
      parts.push(lines.join("\n"));
    }
  }

  // Stated rather than swallowed: a partial answer the caller believes is
  // complete is worse than one that says what it could not reach.
  if (unlinked.length > 0) {
    parts.push(`\n\nNot searched (no linked account): ${unlinked.join(", ")}.`);
  }
  if (refused.length > 0) {
    parts.push(`\n\nCould not search: ${refused.join(", ")}.`);
  }
  return parts.join("");
}
