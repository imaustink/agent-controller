import type { ToolDescriptor } from "../tool-descriptor.js";

/**
 * Metadata filter applied at query time. Kept intentionally small and
 * vendor-neutral (see ADR 0003) — nothing outside the vector-store adapter
 * should need to know this becomes a Qdrant payload filter.
 */
export interface ToolQueryFilter {
  /** Only tools whose `allowedRoles` intersects this set are returned. */
  callerRoles: string[];
}

export interface ToolSearchResult {
  tool: ToolDescriptor;
  score: number;
}

/**
 * Port every vector-store adapter implements (ADR 0003). The agent core only
 * ever depends on this interface, never on a vendor client directly.
 */
export interface VectorStore {
  upsert(tools: ToolDescriptor[]): Promise<void>;
  /**
   * Similarity search scoped by `filter`. Implementations MUST fail closed:
   * an empty `filter.callerRoles` (unresolved identity) returns no results
   * rather than an unfiltered search (ADR 0004).
   */
  query(text: string, filter: ToolQueryFilter, k?: number): Promise<ToolSearchResult[]>;
  /**
   * Direct lookup by id, scoped by `filter` — used when a skill (docs/adr/0008)
   * explicitly declares which tools it may call, so no semantic re-ranking is
   * needed. MUST fail closed the same way `query` does: an empty
   * `filter.callerRoles` returns no results.
   */
  getByIds(ids: string[], filter: ToolQueryFilter): Promise<ToolSearchResult[]>;
  delete(ids: string[]): Promise<void>;
}

/** Port for turning text into an embedding vector, kept separate from VectorStore itself. */
export interface Embedder {
  embed(text: string): Promise<number[]>;
}
