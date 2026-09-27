import type { CorpusSearchResult } from "./types.js";

/**
 * Drops candidates the ACL mirror says this caller could not read.
 *
 * This is a COST optimization and nothing else (docs/adr/0040). Every chunk
 * that survives is still probed against the source with the caller's own token
 * before it can be ranked, prompted or cited, so this can only ever save
 * probes — it can never grant access.
 *
 * That inverts the usual bias, deliberately. Everywhere else here, missing
 * information means fail closed; here it means KEEP. A chunk wrongly kept costs
 * one probe that comes back denied. A chunk wrongly dropped never reaches the
 * probe that would have allowed it, and the caller is told nothing exists — a
 * silent wrong answer, which is the failure a knowledge base exists to prevent.
 *
 * Confidence is narrower than "no principal matched", which is the trap this is
 * mostly written to avoid. Principals are KINDED (`user:`, `group:`), and a
 * caller's set can be complete for one kind and empty for another. A caller
 * whose group memberships have not been resolved holds only `user:` principals,
 * and a page restricted to `group:engineering` matches none of them. Excluding
 * on that basis would hide every group-restricted page from exactly the people
 * entitled to read it. So a chunk is excluded only when every principal kind it
 * names is a kind this caller's set covers.
 *
 * PARITY: `PreFilter` in `engines/temporal/internal/corpus/prefilter.go`.
 */
export function preFilter(
  hits: CorpusSearchResult[],
  callerPrincipals: string[],
): { kept: CorpusSearchResult[]; dropped: number } {
  if (hits.length === 0 || callerPrincipals.length === 0) return { kept: hits, dropped: 0 };

  const held = new Set(callerPrincipals);
  const covered = new Set(callerPrincipals.map(kindOf));

  const kept: CorpusSearchResult[] = [];
  let dropped = 0;
  for (const hit of hits) {
    if (mirrorExcludes(hit, held, covered)) dropped += 1;
    else kept.push(hit);
  }
  return { kept, dropped };
}

/**
 * The part before the FIRST colon — `user` in `user:557058:abc`. Provider ids
 * contain colons themselves, so only the first separator counts.
 */
function kindOf(principal: string): string {
  const index = principal.indexOf(":");
  return index >= 0 ? principal.slice(0, index) : principal;
}

/** Whether the mirror is CONFIDENT this caller is shut out. Anything less is false. */
function mirrorExcludes(hit: CorpusSearchResult, held: Set<string>, covered: Set<string>): boolean {
  const principals = hit.chunk.aclPrincipals ?? [];
  // Permissive and empty both mean "not a usable exclusion set", for different
  // reasons, and neither may drop anything.
  if (hit.chunk.aclPermissive || principals.length === 0) return false;

  for (const principal of principals) {
    if (held.has(principal)) return false;
    // A kind we cannot evaluate is not evidence of exclusion.
    if (!covered.has(kindOf(principal))) return false;
  }
  return true;
}
