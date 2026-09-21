import type { ToolDescriptor } from "../tool-descriptor.js";
import { BrokerProber, retrieve } from "./retrieve.js";
import { render } from "./render.js";
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
 * `engines/temporal/internal/temporal/activities/knowledgebase.go`, where the
 * same resolution deliberately happens inside the activity so a credential
 * never reaches durable workflow history.
 */
export interface DelegatedCredentialResolver {
  delegatedToken(subject: string, providers: string[]): Promise<DelegatedCredential | undefined>;
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
 * `engines/temporal/internal/temporal/activities/knowledgebase.go`.
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
}

const DEFAULT_LIMIT = 6;

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

  async search(tool: ToolDescriptor, query: string, caller: { subject: string; roles: string[] }): Promise<SearchResult> {
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
      return {
        result: render({
          outcome: { chunks: [], denied: 0, undetermined: [], skippedCorpora: 0, preFiltered: 0 },
          withheld,
          disclose: exec.disclosePartialVisibility,
        }),
      };
    }

    const credential = await this.options.credentials.delegatedToken(caller.subject, providersOf(visible));
    const token = credential?.token;
    if (!token) {
      // Probing on the ingestion credential would answer a different question,
      // permissively (docs/adr/0040), so an ask is the only honest response.
      return {
        needsLink: true,
        result:
          `I need you to link the account behind ${exec.displayName} before I can search it — ` +
          "every result has to be checked against your own access to the source.",
      };
    }

    const stores: CorpusStore[] = [];
    let skipped = 0;
    for (const member of visible) {
      const store = await this.options.openCorpus(member.collection);
      if (store) stores.push(store);
      else skipped += 1;
    }

    const prober = new BrokerProber({
      baseUrl: this.options.brokerUrl,
      token: this.options.brokerToken,
      delegatedToken: token,
      granularities: granularitiesOf(visible),
    });

    const outcome = await retrieve(
      stores,
      prober,
      query,
      caller.roles,
      credential?.principals ?? [],
      this.options.limit ?? DEFAULT_LIMIT,
    );

    return {
      result: render({
        // A corpus that could not be opened and one that failed mid-query are
        // the same gap to the person reading the answer.
        outcome: { ...outcome, skippedCorpora: outcome.skippedCorpora + skipped },
        withheld,
        disclose: exec.disclosePartialVisibility,
      }),
    };
  }
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
