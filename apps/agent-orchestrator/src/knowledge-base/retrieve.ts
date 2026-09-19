import { authorize, PermissionDeniedError, TransientProbeError, type AuthorizedChunk, type Granularity, type ProbeRequest, type ProbeResult, type Prober } from "./probe.js";
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
 * PARITY: `DefaultCandidateMultiplier` in `engines/temporal/internal/corpus`.
 */
export const DEFAULT_CANDIDATE_MULTIPLIER = 3;

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
 */
export async function retrieve(
  stores: CorpusStore[],
  prober: Prober,
  query: string,
  callerRoles: string[],
  limit: number,
  multiplier = DEFAULT_CANDIDATE_MULTIPLIER,
): Promise<RetrieveOutcome> {
  const factor = Number.isInteger(multiplier) && multiplier >= 1 ? multiplier : DEFAULT_CANDIDATE_MULTIPLIER;

  const { hits, skipped } = await searchCorpus(stores, query, callerRoles, limit * factor);
  const authorized = await authorize(prober, hits);

  return {
    chunks: authorized.chunks.slice(0, limit),
    denied: authorized.denied,
    undetermined: authorized.undetermined,
    skippedCorpora: skipped,
  };
}

export interface BrokerProberOptions {
  /** Base URL of the connection-broker Service. */
  baseUrl: string;
  /** Authenticates THIS orchestrator to the broker. */
  token: string;
  /** The calling user's own credential, resolved per turn. */
  delegatedToken?: string;
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
    const { baseUrl, token, delegatedToken } = this.options;
    if (!delegatedToken) {
      // Nothing to answer the question with, and the broker would refuse anyway.
      throw new PermissionDeniedError("no delegated credential for this caller");
    }

    const endpoint = `${baseUrl.replace(/\/+$/, "")}/connections/${encodeURIComponent(request.connectionId)}/probe`;

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
    if (response.status === 403 || response.status === 404) {
      throw new PermissionDeniedError(`broker returned ${response.status}`);
    }
    throw new TransientProbeError(`broker returned ${response.status}`);
  }
}
