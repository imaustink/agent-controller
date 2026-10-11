import type { ToolDescriptor } from "../tool-descriptor.js";
import { BrokerProber, retrieve } from "./retrieve.js";
import type { CitedSource } from "./cite.js";
import { caveatLines, render, sources, type RenderInput } from "./render.js";
import type { Granularity } from "./probe.js";
import type { CorpusStore } from "./types.js";
import type { KnowledgeBaseExecMember } from "./exec.js";

/**
 * Opens the store for one member Connection's collection.
 *
 * A factory rather than a registry because collections come and go with
 * Connection CRs: which ones a search touches is decided per request from the
 * knowledge base being searched, not fixed at startup like the catalog's three.
 */
export type CorpusStoreFactory = (collection: string) => Promise<CorpusStore | undefined>;

/**
 * Resolves the calling user's own token for a provider.
 *
 * PARITY: `DelegatedCredentialResolver` in
 * `orchestrator/engines/temporal/internal/temporal/activities/knowledgebase.go`, where the
 * same resolution deliberately happens inside the activity so a credential
 * never reaches durable workflow history.
 */
export interface DelegatedCredentialResolver {
  /**
   * The first linked provider's credential — for single-connection callers (the
   * document reader, the live lookup) that only ever touch one provider.
   */
  delegatedToken(subject: string, providers: string[]): Promise<DelegatedCredential | undefined>;
  /**
   * A credential per linked provider, keyed by provider name. The multi-member
   * search uses this so a knowledge base spanning providers probes each source
   * with the token for ITS provider, and asks for the rest.
   */
  delegatedTokens(subject: string, providers: string[]): Promise<Map<string, DelegatedCredential>>;
}

/**
 * The caller's own credential for a provider, plus the identities it represents
 * THERE.
 *
 * Principals are carried alongside the token because only the credential store
 * knows them: they are provider-shaped (`user:<accountId>`, `group:<id>`), not
 * the cluster-side subject or roles. They feed the ACL mirror's pre-filter and
 * nothing else — a missing or partial set costs probes, never correctness.
 *
 * PARITY: `DelegatedCredential` in
 * `orchestrator/engines/temporal/internal/temporal/activities/knowledgebase.go`.
 */
export interface DelegatedCredential {
  token: string;
  /**
   * May legitimately be empty, or cover only some kinds — group membership in
   * particular needs a provider call that may not have happened. `preFilter`
   * degrades accordingly rather than excluding on a kind it cannot evaluate.
   */
  principals?: string[];
}

export interface KnowledgeBaseSearcherOptions {
  openCorpus: CorpusStoreFactory;
  credentials: DelegatedCredentialResolver;
  brokerUrl: string;
  brokerToken: string;
  /** Passages an answer gets; the probed candidate set is a multiple of this. */
  limit?: number;
}

export interface SearchResult {
  /** The Markdown composition frames verbatim (ADR 0015). Never a credential. */
  result: string;
  /**
   * The caller has not linked the credential this knowledge base's sources
   * require, so nothing could be checked and there is no partial answer.
   */
  needsLink?: boolean;
  /**
   * Which providers the caller must link, when `needsLink`. The executing layer
   * (agent/graph.ts) uses this to START the OAuth flow and hand back a clickable
   * link — the searcher itself holds no link-start gateway.
   */
  linkProviders?: string[];
  /**
   * This search's citable passages, numbered from the `firstIndex` it was given,
   * with the probe's title and URL; and what it could not see. Both carried out
   * separately so the graph applies them in CODE to whatever the turn finally
   * returns — the model's `[n]` markers become these links, and the caveats are
   * appended whatever the model wrote (ADR 0040 survives finish/respond alike).
   * Absent when nothing was searched (the needs-link asks).
   *
   * PARITY: `SearchKnowledgeBaseOutput.Sources`/`.Caveats` on the Temporal engine.
   */
  sources?: CitedSource[];
  caveats?: string[];
}

/**
 * The result of the deterministic pre-search link check (`checkLinks`): which of
 * a knowledge base's providers the caller has, and has not, linked. The executing
 * layer (agent/graph.ts) uses this to stop the turn and ask BEFORE searching,
 * rather than relying on the planner to relay a "link this too" caveat.
 */
export interface LinkCheck {
  /** Providers of visible members the caller has NOT linked (sorted). */
  linkProviders: string[];
  /** Providers of visible members the caller HAS linked (sorted). */
  linkedProviders: string[];
}

// How many passages an answer gets; the probed candidate set is a multiple of
// this. Six starved multi-document questions (a "what are all our projects for
// X" drew on one source and read as thin); twelve gives the model enough spread
// to synthesise across sources while staying well inside the context budget (a
// chunk is capped at 800 tokens at ingest). PARITY: defaultKnowledgeBaseLimit on
// the Temporal engine.
const DEFAULT_LIMIT = 12;

/**
 * Executes a knowledge base's generated search tool (docs/adr/0039 §3).
 *
 * PARITY: `KnowledgeBaseActivities.SearchKnowledgeBase` on the Temporal engine.
 * The shape is the same because the guarantees are: source-level filtering
 * before any query so the withheld count exists, a delegated credential or an
 * honest ask, and probe-derived citations.
 */
export class KnowledgeBaseSearcher {
  constructor(private readonly options: KnowledgeBaseSearcherOptions) {}

  /**
   * The deterministic pre-search link check: which of this knowledge base's
   * providers the caller has, and has not, linked — WITHOUT running the query or
   * probe. The graph calls it once per knowledge-base engagement and stops the
   * turn when `linkProviders` is non-empty, so a core auth behaviour does not
   * depend on the model echoing a caveat.
   *
   * PARITY: `SearchKnowledgeBaseInput.GateOnly` on the Temporal engine.
   */
  async checkLinks(tool: ToolDescriptor, caller: { subject: string; roles: string[] }): Promise<LinkCheck> {
    const exec = tool.knowledgeBaseExec;
    if (!exec || exec.operation !== "search" || !caller.subject) {
      return { linkProviders: [], linkedProviders: [] };
    }
    const { visible } = visibleMembers(exec.members, caller.roles);
    if (visible.length === 0) return { linkProviders: [], linkedProviders: [] };
    const tokens = await this.options.credentials.delegatedTokens(caller.subject, providersOf(visible));
    return {
      linkProviders: providersToLink(visible, tokens),
      linkedProviders: linkedProviders(visible, tokens),
    };
  }

  /**
   * `firstIndex` is the citation number this search's first passage takes: the
   * turn's next unused number, so a second search never reuses [1].
   */
  async search(
    tool: ToolDescriptor,
    query: string,
    caller: { subject: string; roles: string[] },
    firstIndex = 1,
  ): Promise<SearchResult> {
    const exec = tool.knowledgeBaseExec;
    if (!exec) throw new Error(`tool ${tool.id} carries no knowledge-base execution spec`);

    // This path only knows how to search. A `fetch` operation would need a
    // whole-document read from the source, an adapter ADR 0040 defers — so no
    // fetch tool is generated. Fail closed rather than let a mis-generated
    // fetch spec silently run a similarity search over the source id, which
    // would return ranked passages dressed up as a document fetch.
    if (exec.operation !== "search") {
      return {
        result:
          `I cannot ${exec.operation} ${exec.displayName}: only search is supported for this knowledge base.`,
      };
    }

    if (!caller.subject) {
      // Fail closed, as every retrieval here does.
      return { result: "I could not establish who is asking, so I cannot search this knowledge base." };
    }

    const { visible, withheld } = visibleMembers(exec.members, caller.roles);
    if (visible.length === 0) {
      const renderInput: RenderInput = {
        outcome: { chunks: [], denied: 0, undetermined: [], skippedCorpora: 0, preFiltered: 0 },
        withheld,
        disclose: exec.disclosePartialVisibility,
      };
      return { result: render(renderInput), caveats: caveatLines(renderInput) };
    }

    const tokens = await this.options.credentials.delegatedTokens(caller.subject, providersOf(visible));
    if (tokens.size === 0) {
      // Probing on the ingestion credential would answer a different question,
      // permissively (docs/adr/0040), so an ask is the only honest response.
      return needsLinkAsk(exec.displayName, providersToLink(visible, tokens));
    }

    // Each member's connection must be probed with the token for ITS provider.
    // A member whose provider the caller has not linked is NOT probed on another
    // provider's token — that is the wrong question and silently drops results —
    // it becomes an honest "link this to see more" instead.
    const servable: KnowledgeBaseExecMember[] = [];
    const notLinked: KnowledgeBaseExecMember[] = [];
    const tokenByConnection = new Map<string, string>();
    const principals = new Set<string>();
    for (const member of visible) {
      const provider = (member.identityProviders ?? []).find((p) => tokens.has(p));
      if (!provider) {
        notLinked.push(member);
        continue;
      }
      const credential = tokens.get(provider)!;
      servable.push(member);
      tokenByConnection.set(member.id, credential.token);
      for (const principal of credential.principals ?? []) principals.add(principal);
    }

    if (servable.length === 0) {
      return needsLinkAsk(exec.displayName, providersToLink(visible, tokens));
    }

    const stores: CorpusStore[] = [];
    let skipped = 0;
    for (const member of servable) {
      const store = await this.options.openCorpus(member.collection);
      if (store) stores.push(store);
      else skipped += 1;
    }

    const prober = new BrokerProber({
      baseUrl: this.options.brokerUrl,
      token: this.options.brokerToken,
      delegatedTokens: tokenByConnection,
      granularities: granularitiesOf(servable),
    });

    const outcome = await retrieve(
      stores,
      prober,
      query,
      caller.roles,
      [...principals],
      this.options.limit ?? DEFAULT_LIMIT,
    );

    const unlinkedProviders = providersToLink(notLinked, tokens);
    const renderInput: RenderInput = {
      // A corpus that could not be opened and one that failed mid-query are
      // the same gap to the person reading the answer.
      outcome: { ...outcome, skippedCorpora: outcome.skippedCorpora + skipped },
      withheld,
      disclose: exec.disclosePartialVisibility,
      // Members whose provider the caller has not linked: served sources are
      // real, and this says what more a link would add rather than hiding it.
      unlinked: { providers: unlinkedProviders, sources: notLinked.length },
      firstIndex,
    };
    return {
      result: render(renderInput),
      // Carried out separately so the graph can apply them in code even when the
      // planner recomposes the answer via `respond` (ADR 0040 citations survive
      // finish/respond alike).
      sources: sources(renderInput),
      caveats: caveatLines(renderInput),
      // A partial answer still carries the providers to link, so the executing
      // layer offers a fresh clickable link for each — the one still missing can
      // be linked incrementally without blocking the sources already answered.
      ...(unlinkedProviders.length > 0 ? { linkProviders: unlinkedProviders } : {}),
    };
  }
}

/**
 * The honest response when the caller has linked none of the providers a search
 * needs: ask, naming which, rather than answer on a credential that is not
 * theirs (docs/adr/0040).
 */
function needsLinkAsk(displayName: string, providers: string[]): SearchResult {
  const which = providers.length > 0 ? ` (${providers.join(", ")})` : "";
  return {
    needsLink: true,
    linkProviders: providers,
    result:
      `I need you to link the account behind ${displayName}${which} before I can search it — ` +
      "every result has to be checked against your own access to the source.",
  };
}

/** The providers these members need that the caller has not linked, sorted. */
function providersToLink(
  members: KnowledgeBaseExecMember[],
  linked: ReadonlyMap<string, unknown>,
): string[] {
  return [
    ...new Set(members.flatMap((member) => member.identityProviders ?? []).filter((p) => !linked.has(p))),
  ].sort();
}

/** The providers these members need that the caller HAS linked, sorted. */
function linkedProviders(
  members: KnowledgeBaseExecMember[],
  linked: ReadonlyMap<string, unknown>,
): string[] {
  return [
    ...new Set(members.flatMap((member) => member.identityProviders ?? []).filter((p) => linked.has(p))),
  ].sort();
}

/**
 * The source-level access filter (docs/adr/0039 §4): which members this caller
 * may consult at all, and how many were withheld.
 *
 * Doing it before any query is what makes the COUNT available — a role-filtered
 * query cannot afterwards report what it declined to return, and "nothing
 * matched" and "nothing you may see matched" become indistinguishable.
 *
 * A member with no collection counts as withheld rather than visible: nothing
 * is indexed to search, and that is still something the answer is missing.
 */
export function visibleMembers(
  members: KnowledgeBaseExecMember[],
  callerRoles: string[],
): { visible: KnowledgeBaseExecMember[]; withheld: number } {
  const held = new Set(callerRoles);
  const visible: KnowledgeBaseExecMember[] = [];
  let withheld = 0;

  for (const member of members) {
    if (!member.allowedRoles.some((role) => held.has(role)) || !member.collection) {
      withheld += 1;
      continue;
    }
    visible.push(member);
  }
  return { visible, withheld };
}

/** The union of providers the visible members need, sorted for a stable request. */
function providersOf(members: KnowledgeBaseExecMember[]): string[] {
  return [...new Set(members.flatMap((member) => member.identityProviders ?? []))].sort();
}

function granularitiesOf(members: KnowledgeBaseExecMember[]): Map<string, Granularity> {
  return new Map(
    members.map((member) => [member.id, member.granularity === "connection" ? "connection" : "resource"]),
  );
}
