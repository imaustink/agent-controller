import { authorize, PermissionDeniedError, TransientProbeError, type AuthorizedChunk, type Granularity, type ProbeRequest, type ProbeResult, type Prober } from "./probe.js";
import { preFilter } from "./prefilter.js";
import { rerank } from "./rerank.js";
import { searchCorpus } from "./search.js";
import type { CorpusStore } from "./types.js";

/**
 * How far retrieval over-fetches before probing.
 *
 * Probing drops candidates, so asking for exactly the context window's worth
 * would starve the answer whenever the mirror was optimistic. ADR 0040 says
 * start at 3x and tune from observed drop rates — an operational question,
 * which is why this is a starting point rather than a constant nobody revisits.
 *
 * Raised 3→5 alongside the larger answer limit and the rerank step: with more
 * passages wanted per answer, a wider candidate pool keeps probe drops from
 * starving it and gives the rerank something to choose from.
 *
 * PARITY: `DefaultCandidateMultiplier` in `engines/temporal/internal/corpus`.
 */
export const DEFAULT_CANDIDATE_MULTIPLIER = 5;

export interface RetrieveOutcome {
  chunks: AuthorizedChunk[];
  /** Candidates the source refused — expected, and a measure of the mirror's optimism. */
  denied: number;
  /**
   * Sources whose probe failed transiently, and member collections that could
   * not be searched at all. Both are surfaced because an answer quietly missing
   * evidence is worse than one that admits it could not check.
   */
  undetermined: string[];
  skippedCorpora: number;
  /**
   * Candidates the ACL mirror excluded before any probe was made. Purely a
   * saving: reported so the mirror's usefulness is measurable, and so a
   * suspiciously large number is visible rather than looking like a thin corpus.
   */
  preFiltered: number;
}

/**
 * The whole read path for a knowledge base: fan out, merge, probe, and hand
 * back only what the source confirmed this caller may read.
 *
 * The two halves answer different questions and neither substitutes for the
 * other. The mirror decides what is WORTH asking about — cheap, approximate,
 * deliberately biased toward over-inclusion. The source decides what may be
 * SEEN, per user, at query time. ADR 0040's governing rule is that the first is
 * never allowed to stand in for the second.
 *
 * `callerPrincipals` are the caller's PROVIDER-side identities, a different
 * thing from `callerRoles`: roles gate which corpora may be searched at all,
 * principals only pre-filter within the results. Empty is legitimate and simply
 * skips the pre-filter — see `preFilter` for why that direction is the safe one.
 */
export async function retrieve(
  stores: CorpusStore[],
  prober: Prober,
  query: string,
  callerRoles: string[],
  callerPrincipals: string[],
  limit: number,
  multiplier = DEFAULT_CANDIDATE_MULTIPLIER,
): Promise<RetrieveOutcome> {
  const factor = Number.isInteger(multiplier) && multiplier >= 1 ? multiplier : DEFAULT_CANDIDATE_MULTIPLIER;

  const { hits, skipped } = await searchCorpus(stores, query, callerRoles, limit * factor);
  // Cheap exclusion before the expensive question. This can only reduce the
  // number of probes, never widen what is returned.
  const { kept, dropped } = preFilter(hits, callerPrincipals);
  const authorized = await authorize(prober, kept);

  // Reorder the survivors by relevance (vector score blended with keyword
  // overlap) BEFORE the cut, so the kept `limit` are the most relevant rather
  // than merely the highest-cosine. Order-only: it adds and drops nothing, so
  // the probe's access guarantees still hold.
  const ranked = rerank(query, authorized.chunks);

  return {
    chunks: ranked.slice(0, limit),
    denied: authorized.denied,
    undetermined: authorized.undetermined,
    skippedCorpora: skipped,
    preFiltered: dropped,
  };
}

export interface BrokerProberOptions {
  /** Base URL of the connection-broker Service. */
  baseUrl: string;
  /** Authenticates THIS orchestrator to the broker. */
  token: string;
  /**
   * The calling user's own credential, resolved per turn. Used when no
   * per-connection token is supplied, and by single-connection callers (the
   * document reader and live lookup) that only ever touch one provider.
   */
  delegatedToken?: string;
  /**
   * The caller's own credential PER CONNECTION, keyed by connectionId.
   *
   * A knowledge base can span providers, and each connection must be probed with
   * the token for ITS provider — probing a Slack channel with an Atlassian token
   * is not a denial, it is the wrong question, and it silently drops results the
   * caller can actually see. The searcher resolves one token per provider and
   * maps each member connection to the right one; this is where that mapping is
   * spent. Falls back to `delegatedToken` for any connection not in the map.
   */
  delegatedTokens?: ReadonlyMap<string, string>;
  /** Per-connection probe unit, taken from the catalog rather than guessed. */
  granularities?: ReadonlyMap<string, Granularity>;
  fetchImpl?: typeof fetch;
}

/**
 * Asks the connection-broker whether the calling user may read a resource.
 *
 * The orchestrator holds no third-party credential of its own: it forwards the
 * user's delegated token per request, and the broker refuses to let it spend a
 * connection's service credential at all. So this carries a credential it did
 * not mint and cannot widen.
 *
 * PARITY: `BrokerProber` in `engines/temporal/internal/corpus/broker.go`.
 */
export class BrokerProber implements Prober {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: BrokerProberOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  granularity(connectionId: string): Granularity {
    // An unknown provider is probed per resource: assuming per-connection would
    // let one allowed resource vouch for every other candidate from that source.
    return this.options.granularities?.get(connectionId) ?? "resource";
  }

  async probe(request: ProbeRequest): Promise<ProbeResult> {
    const { baseUrl, token } = this.options;
    // The token for THIS connection's provider, falling back to the single
    // delegated token for callers that carry only one.
    const delegatedToken =
      this.options.delegatedTokens?.get(request.connectionId) ?? this.options.delegatedToken;
    if (!delegatedToken) {
      // Nothing to answer the question with, and the broker would refuse anyway.
      throw new PermissionDeniedError("no delegated credential for this caller");
    }

    // `/corpora/`, not `/connections/`. Data is addressed by CORPUS; the
    // `/connections/` prefix survives only for webhooks (docs/adr/0043).
    const endpoint = `${baseUrl.replace(/\/+$/, "")}/corpora/${encodeURIComponent(request.connectionId)}/probe`;

    let response: Response;
    try {
      response = await this.fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "x-delegated-token": delegatedToken,
        },
        body: JSON.stringify({ sourceId: request.sourceId }),
      });
    } catch (cause) {
      // Could not reach the broker. NOT a denial: treating it as one would
      // quietly shrink the answer and make the same question return different
      // evidence on a retry.
      throw new TransientProbeError(`connection-broker unreachable: ${String(cause)}`);
    }

    if (response.ok) return (await response.json()) as ProbeResult;

    // 403 is the ONLY denial. The broker answers a driver's
    // PermissionDeniedError with 403 and nothing else, so treating any other
    // status as "this caller may not see it" converts a fault into a silent,
    // total and invisible drop.
    //
    // 404 in particular used to be read as a denial, and it hid this exact
    // bug: the endpoint above named a route that no longer exists, so every
    // probe 404'd, every candidate was "denied", and retrieval answered "no
    // passages matched" — indistinguishable from an empty corpus. A 404 means
    // the corpus or the route is missing, which is a fault to surface.
    if (response.status === 403) {
      throw new PermissionDeniedError(`broker returned ${response.status}`);
    }
    throw new TransientProbeError(`broker returned ${response.status}`);
  }
}
