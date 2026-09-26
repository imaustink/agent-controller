/**
 * What a knowledge base's generated tools carry so the executing side needs no
 * second source of truth (docs/adr/0039).
 *
 * Membership is snapshotted at index time rather than resolved at call time, so
 * a search runs over exactly what the planner was offered — a knowledge base
 * edited mid-turn cannot silently widen what gets consulted.
 *
 * PARITY: `KnowledgeBaseExecSpec` in
 * `engines/temporal/internal/catalog/descriptors.go`.
 */
export interface KnowledgeBaseExecMember {
  id: string;
  label: string;
  /**
   * Where this member's chunks live. Empty until its Connection has been
   * reconciled, which makes it unsearchable rather than an error.
   */
  collection: string;
  /**
   * Decides whether this caller may consult the member at all — the
   * source-level filter that runs before any query and produces the withheld
   * count (docs/adr/0039 §4).
   */
  allowedRoles: string[];
  /**
   * The unit this member's provider authorizes at, so probes are deduplicated
   * where that is the real access boundary (docs/adr/0040).
   */
  granularity?: "resource" | "connection";
  /**
   * Providers whose delegated credential a probe needs. Empty means this member
   * cannot serve a caller whose access differs from the ingestion credential's.
   */
  identityProviders?: string[];
}

export interface KnowledgeBaseExecSpec {
  knowledgeBaseId: string;
  displayName: string;
  /** "fetch" is legacy: no such tool is generated (docs/adr/0040). */
  operation: "search" | "read" | "fetch";
  members: KnowledgeBaseExecMember[];
  disclosePartialVisibility: boolean;
}
