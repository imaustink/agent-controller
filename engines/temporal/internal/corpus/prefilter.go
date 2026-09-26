package corpus

import "strings"

// PreFilter drops candidates the ACL mirror says this caller could not read.
//
// This is a COST optimization and nothing else (ADR 0040). Every chunk that
// survives is still probed against the source with the caller's own token
// before it can be ranked, prompted or cited, so this function can only ever
// save probes — it can never grant access.
//
// That inverts the usual bias, and deliberately. Everywhere else in this
// system, missing information means fail closed; here it means KEEP. A chunk
// wrongly kept costs one probe that comes back denied. A chunk wrongly dropped
// never reaches the probe that would have allowed it, and the caller is told
// nothing exists — a silent wrong answer, which is the failure a knowledge base
// exists to prevent. So a chunk is dropped only when the mirror is CONFIDENT.
//
// Confidence is narrower than "no principal matched", which is the trap this
// function is mostly written to avoid. Principals are KINDED — "user:<id>",
// "group:<id>" — and a caller's set can be complete for one kind and empty for
// another. A caller whose group memberships have not been resolved holds only
// "user:" principals, and a chunk restricted to "group:engineering" would match
// none of them. Excluding on that basis would hide, from exactly the people
// entitled to read it, every page restricted by group.
//
// So a chunk is excluded only when every principal kind it names is a kind this
// caller's set covers. Unresolved group membership then degrades to "probe it
// and find out" rather than to "pretend it is not there", and the filter starts
// working for groups on its own the moment group principals are supplied.
//
// Empty callerPrincipals filters nothing, by the same reasoning.
func PreFilter(hits []Hit, callerPrincipals []string) (kept []Hit, dropped int) {
	if len(hits) == 0 || len(callerPrincipals) == 0 {
		return hits, 0
	}

	held := make(map[string]struct{}, len(callerPrincipals))
	covered := make(map[string]struct{}, 2)
	for _, principal := range callerPrincipals {
		held[principal] = struct{}{}
		covered[kindOf(principal)] = struct{}{}
	}

	kept = make([]Hit, 0, len(hits))
	for _, hit := range hits {
		if mirrorExcludes(hit.Chunk, held, covered) {
			dropped++
			continue
		}
		kept = append(kept, hit)
	}
	return kept, dropped
}

// kindOf is the part before the first colon — "user" in "user:557058:abc".
// Provider ids contain colons themselves, so only the FIRST separator counts.
func kindOf(principal string) string {
	if idx := strings.Index(principal, ":"); idx >= 0 {
		return principal[:idx]
	}
	return principal
}

// mirrorExcludes reports whether the mirror is confident this caller is shut
// out. Anything short of confident is false.
func mirrorExcludes(chunk Chunk, held, covered map[string]struct{}) bool {
	// The driver could not resolve effective permissions, so the list is not a
	// usable exclusion set. Distinct from an empty list, which means "nobody is
	// specially granted" and is equally unusable for exclusion.
	if chunk.ACLPermissive || len(chunk.ACLPrincipals) == 0 {
		return false
	}

	for _, principal := range chunk.ACLPrincipals {
		if _, ok := held[principal]; ok {
			return false
		}
		if _, ok := covered[kindOf(principal)]; !ok {
			// A kind we cannot evaluate. Not evidence of exclusion.
			return false
		}
	}
	return true
}
