import type { CorpusChunk, CorpusSearchResult } from "./types.js";

/**
 * The unit a provider authorizes at (docs/adr/0040).
 *
 * It differs per provider and is not a wrinkle to work around. Confluence and
 * Drive authorize a page or a file; Slack authorizes a CHANNEL, because
 * membership is the access unit and there is no per-message permission to
 * check. A per-connection provider therefore settles every candidate from that
 * connection with one probe, which is cheaper than the per-resource case rather
 * than harder.
 *
 * PARITY: `engines/temporal/internal/corpus/probe.go`.
 */
export type Granularity = "resource" | "connection";

/** Identifies what to authorize. `sourceId` is absent for connection granularity. */
export interface ProbeRequest {
  connectionId: string;
  sourceId?: string;
}

/**
 * The source's answer, and the ONLY acceptable origin for anything displayable.
 *
 * Title and URL come back here rather than from the mirror because citations
 * are content (docs/adr/0040): an answer that cites a page title the user may
 * not read has disclosed the thing while appearing to have returned nothing.
 */
export interface ProbeResult {
  allowed: boolean;
  title: string;
  url: string;
  /**
   * The version the source holds right now. A mismatch against the indexed
   * chunk means the passage is stale — still usable, while saying so, or
   * replaceable by fetching the live document.
   */
  version?: string;
}

/**
 * Asks the source, as the calling user, whether a resource is readable.
 *
 * Implementations MUST distinguish error classes: a permission failure is a
 * drop, anything else is not. Returning a transient failure as a denial makes
 * the same question return different evidence depending on whether the source
 * was busy.
 */
export interface Prober {
  granularity(connectionId: string): Granularity;
  probe(request: ProbeRequest): Promise<ProbeResult>;
}

/** The source says this user may not read it. Drop. */
export class PermissionDeniedError extends Error {
  readonly name = "PermissionDeniedError";
}

/**
 * We could not find out — a 429, a 5xx, a timeout.
 *
 * Deliberately NOT a denial. Treating it as one silently shrinks an answer in a
 * way nobody can see, and makes results non-deterministic across retries.
 */
export class TransientProbeError extends Error {
  readonly name = "TransientProbeError";
}

/**
 * A candidate the source confirmed this user may read. `title` and `url`
 * shadow anything the chunk carried: they are the probe's, not the mirror's.
 */
export interface AuthorizedChunk {
  chunk: CorpusChunk;
  score: number;
  title: string;
  url: string;
  version?: string;
  /**
   * The source has moved past the indexed version. Still readable by this user,
   * so not dropped — but an answer built on it should say how old it is, or
   * fetch the live document instead.
   */
  stale: boolean;
}

export interface AuthorizeOutcome {
  chunks: AuthorizedChunk[];
  /**
   * How many candidates the source refused. Expected and harmless: it measures
   * the mirror's staleness in the permissive direction.
   */
  denied: number;
  /**
   * Sources whose probe failed transiently. NOT dropped silently — the caller
   * surfaces them as a partial-results warning, because an answer quietly
   * missing evidence is worse than one that admits it could not check.
   */
  undetermined: string[];
}

/**
 * The gate between candidate retrieval and anything the model sees
 * (docs/adr/0040).
 *
 * The mirror got us a short list; this is where the source decides. Every
 * surviving chunk was confirmed readable, at query time, by the source system
 * itself under this user's own credentials.
 *
 * Probes are de-duplicated before they are issued — by connection for a
 * connection-granularity provider, by source otherwise — so eight chunks from
 * one page cost one probe, not eight. That de-duplication is most of why this
 * step is affordable.
 */
export async function authorize(
  prober: Prober,
  hits: CorpusSearchResult[],
): Promise<AuthorizeOutcome> {
  if (hits.length === 0) return { chunks: [], denied: 0, undetermined: [] };

  const keyFor = (chunk: CorpusChunk): string =>
    prober.granularity(chunk.connectionId) === "connection"
      ? `${chunk.connectionId}\u0000`
      : `${chunk.connectionId}\u0000${chunk.sourceId}`;

  const requests = new Map<string, ProbeRequest>();
  for (const hit of hits) {
    const key = keyFor(hit.chunk);
    if (!requests.has(key)) {
      requests.set(
        key,
        prober.granularity(hit.chunk.connectionId) === "connection"
          ? { connectionId: hit.chunk.connectionId }
          : { connectionId: hit.chunk.connectionId, sourceId: hit.chunk.sourceId },
      );
    }
  }

  const keys = [...requests.keys()];
  const settled = await Promise.allSettled(keys.map((key) => prober.probe(requests.get(key)!)));

  const results = new Map<string, PromiseSettledResult<ProbeResult>>();
  for (let i = 0; i < keys.length; i += 1) {
    results.set(keys[i]!, settled[i]!);
  }

  // An error that is neither a denial nor transient is a programming error in
  // the driver, not an authorization answer. Failing the whole search is
  // correct: guessing which it meant is how a leak gets introduced.
  for (const outcome of settled) {
    if (outcome.status === "rejected") {
      const reason: unknown = outcome.reason;
      const classified =
        reason instanceof PermissionDeniedError || reason instanceof TransientProbeError;
      if (!classified) throw reason;
    }
  }

  const chunks: AuthorizedChunk[] = [];
  const undetermined = new Set<string>();
  let denied = 0;

  for (const hit of hits) {
    const outcome = results.get(keyFor(hit.chunk))!;

    if (outcome.status === "rejected") {
      if (outcome.reason instanceof TransientProbeError) {
        undetermined.add(`${hit.chunk.connectionId}/${hit.chunk.sourceId}`);
      } else {
        denied += 1;
      }
      continue;
    }
    if (!outcome.value.allowed) {
      denied += 1;
      continue;
    }

    chunks.push({
      chunk: hit.chunk,
      score: hit.score,
      title: outcome.value.title,
      url: outcome.value.url,
      version: outcome.value.version,
      // A provider reporting no version cannot show a chunk to be stale, so do
      // not claim that it is.
      stale: Boolean(outcome.value.version) && outcome.value.version !== hit.chunk.version,
    });
  }

  return { chunks, denied, undetermined: [...undetermined].sort() };
}
