/**
 * Shared ABAC (attribute-based access control) private-scoping helpers for the
 * Qdrant-backed stores (docs/adr/0037). Kept next to `qdrant-id.ts` so the
 * three stores (tool, agent, skill) enforce the SAME rule the same way, and so
 * the vector-store adapters remain the only modules that know the Qdrant
 * payload/filter shape.
 *
 * The rule, layered ON TOP of the existing `allowedRoles` RBAC filter (ADR
 * 0004): a resource is a candidate for a caller iff it is NOT private, OR the
 * caller's resolved principal is one of its `allowedPrincipals`.
 *
 * Points written before this field existed read back with `private` absent;
 * Qdrant's `match { value: false }` does NOT match a missing key, so every
 * store also writes an explicit `private: false` on upsert. A rolling upgrade
 * therefore re-indexes as CRs are re-observed (the catalog is re-listed at
 * startup, ADR 0020), and until then a pre-upgrade point simply won't match
 * the `private:false` clause — fail-closed, never fail-open.
 */

/** Qdrant payload keys the ABAC clause reads. Written by every store's upsert. */
export interface AbacPayload {
  /** The resource's private-scope list; empty when the resource is public. */
  allowedPrincipals: string[];
  /** `allowedPrincipals.length > 0` — a denormalized flag the filter matches on. */
  private: boolean;
}

/**
 * Builds the ABAC portion of an `upsert` payload from a descriptor's
 * `allowedPrincipals` (absent/empty -> public).
 */
export function abacPayload(allowedPrincipals: string[] | undefined): AbacPayload {
  const list = allowedPrincipals ?? [];
  return { allowedPrincipals: list, private: list.length > 0 };
}

/**
 * The ABAC clause to add to a Qdrant query filter's `must` array: a nested
 * filter that matches when the point is public OR names the caller's
 * principal. Placed under `must` so it is AND-combined with the RBAC clause(s).
 */
export function abacMustClause(callerPrincipal: string) {
  return {
    should: [
      { key: "private", match: { value: false } },
      { key: "allowedPrincipals", match: { any: [callerPrincipal] } },
    ],
  };
}

/**
 * In-memory counterpart of {@link abacMustClause} for `getByIds` (which reads
 * points by id and filters in code): true iff the resource is public or names
 * the caller's principal. Treats an absent/empty list as public.
 */
export function principalAllowed(
  allowedPrincipals: string[] | null | undefined,
  callerPrincipal: string,
): boolean {
  return !allowedPrincipals || allowedPrincipals.length === 0 || allowedPrincipals.includes(callerPrincipal);
}
