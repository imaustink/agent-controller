/**
 * Knowledge bases (docs/adr/0039) and the scoped Corpora they compose
 * (docs/adr/0038).
 *
 * PARITY: `engines/temporal/internal/catalog/knowledgebase.go` and
 * `engines/temporal/internal/corpus` are this module's twin on the Temporal
 * engine (ADR 0036). Both engines derive the same skill from the same CRs, and
 * the derived markdown is PROMPT MATERIAL — if the two drift, one knowledge
 * base answers differently depending on which engine served the turn. Change
 * them together.
 */

/**
 * Id prefixes namespacing derived entries away from the authored catalog, the
 * same way caller-supplied tools are namespaced (docs/adr/0035). A derived
 * knowledge-base skill shares the `skills` collection with authored Skill CRs,
 * so its id must not be able to collide with one.
 */
export const KNOWLEDGE_BASE_ID_PREFIX = "kb:";
export const CORPUS_ID_PREFIX = "corpus:";

export const knowledgeBaseSkillId = (name: string) => `${KNOWLEDGE_BASE_ID_PREFIX}${name}`;
export const knowledgeBaseSearchToolId = (name: string) =>
  `${KNOWLEDGE_BASE_ID_PREFIX}${name}/search`;
export const knowledgeBaseFetchToolId = (name: string) =>
  `${KNOWLEDGE_BASE_ID_PREFIX}${name}/fetch`;
/** A Corpus's scope-enforced GET face (docs/adr/0038 §5). */
export const corpusGetToolId = (name: string) => `${CORPUS_ID_PREFIX}${name}/get`;

/**
 * One scoped external resource subset — this Confluence space, this Slack
 * channel, this Drive folder (docs/adr/0038).
 *
 * Scope and credentials are deliberately absent: they belong to the
 * connection-broker, the only thing that dereferences them. What the
 * orchestrator needs is which collection to search, who may see it, and how to
 * name it in a citation.
 */
export interface CorpusDescriptor {
  id: string;
  provider: string;
  /** What a citation renders; two Slack channels differ only by this. */
  displayName?: string;
  description: string;
  allowedRoles: string[];
  /**
   * Read from `Connection.status`, not recomputed. The controller assigns it
   * (namespace-qualified, since collections are global while CR names are only
   * unique per namespace) and publishing it keeps one source of truth.
   * Absent until the Corpus has been reconciled.
   */
  collection?: string;
  /** Whether this connection contributes a GET tool to knowledge bases including it. */
  apiEnabled: boolean;
  /**
   * The providers whose per-user delegated credential this connection needs to
   * serve a retrieval (docs/adr/0040). Empty means it can be ingested but not
   * probed, so it cannot answer for a caller whose access differs from the
   * ingestion credential's.
   */
  identityProviders: string[];
}

/** Composes Corpora into a queryable corpus (docs/adr/0039). */
export interface KnowledgeBaseDescriptor {
  id: string;
  displayName?: string;
  description: string;
  aliases: string[];
  corpusRefs: string[];
  /**
   * Makes a search report how many member connections this caller could not
   * see, so the agent can distinguish "nothing exists" from "nothing you may
   * see exists" (docs/adr/0039 §4).
   */
  disclosePartialVisibility: boolean;
}

/** What a citation renders for a connection. */
export const connectionLabel = (connection: CorpusDescriptor) =>
  connection.displayName || connection.id;

/** The human name for a knowledge base. */
export const knowledgeBaseLabel = (kb: KnowledgeBaseDescriptor) => kb.displayName || kb.id;

/**
 * One indexed passage: the payload stored alongside a corpus point.
 *
 * Provenance travels with every chunk because a knowledge-base answer is
 * required to cite. A chunk that reached the planner without a `sourceUrl`
 * cannot be cited, and an uncited claim about a client's material is not an
 * acceptable answer.
 */
export interface CorpusChunk {
  connectionId: string;
  connectionLabel?: string;
  sourceUrl: string;
  sourceId: string;
  title?: string;
  /** When the SOURCE last changed (RFC 3339), so an answer can admit its age. */
  updatedAt?: string;
  /**
   * sha256 over the normalized chunk text. Doubles as the point id
   * (docs/adr/0039 §7) — which is what makes a re-sync re-embed only what
   * changed — and is how the same document reached through two Corpora is
   * de-duplicated at merge.
   */
  contentHash: string;
  /**
   * The version of the SOURCE this chunk was built from. Compared against the
   * probe's version (docs/adr/0040) to tell whether the indexed passage has
   * been overtaken; carried rather than derived because only the driver knows
   * what a version means for its provider.
   */
  version?: string;
  text: string;

  /**
   * The MIRROR of the source's read restrictions, captured at ingest —
   * provider-shaped strings like `user:<accountId>` or `group:<id>`
   * (docs/adr/0040).
   *
   * It exists to make retrieval cheaper, never to decide access. It is a
   * snapshot of permissions that may have changed a second after it was taken,
   * and the source is asked again, per user, before any of it is shown.
   *
   * PARITY: `ACLPrincipals` on `corpus.Chunk`.
   */
  aclPrincipals?: string[];
  /**
   * Marks a chunk whose effective permissions the driver could not resolve, so
   * `aclPrincipals` is not a usable exclusion set.
   *
   * Set deliberately rather than inferred from an empty list, because the two
   * mean opposite things: empty on a non-permissive chunk is "nobody is
   * specially granted", while permissive is "we do not know, so do not exclude
   * anyone on this".
   */
  aclPermissive?: boolean;
}

export interface CorpusQueryFilter {
  /** Only chunks whose roles intersect this set are returned. */
  callerRoles: string[];
}

export interface CorpusSearchResult {
  chunk: CorpusChunk;
  score: number;
}

/**
 * Port over ONE member Connection's collection, mirroring `VectorStore`'s
 * relationship to the tool catalog (ADR 0003 — the agent core never depends on
 * a vendor client).
 *
 * Implementations MUST fail closed: an empty `filter.callerRoles` returns no
 * results rather than an unfiltered search (ADR 0004).
 */
export interface CorpusStore {
  query(text: string, filter: CorpusQueryFilter, k: number): Promise<CorpusSearchResult[]>;
}
