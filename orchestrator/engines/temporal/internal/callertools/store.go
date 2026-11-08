package callertools

import (
	"context"
	"log"
)

// Store is the caller-tool index.
//
// Its own collection, deliberately separate from the catalog's, so a caller's
// ephemeral definitions can never enter another caller's candidate set, the
// no-match fallback's catalog-wide sweep, or a sub-agent's toolRefs
// resolution — and so catalog recall and latency are untouched by construction
// rather than by discipline.
//
// There is no RBAC filter here, unlike every other store in this system. That
// is not an oversight. Search only ever ranks definitions whose hashes came
// from the request body being served, so it cannot surface anything the caller
// did not just supply — and "may this caller use this tool?" is vacuous for a
// function the caller both supplied and will run themselves, in their own
// process, under their own credentials. This system never gains a capability
// here; it only learns that the caller has one.
type Store interface {
	// Index embeds and upserts only definitions not already present, and
	// refreshes lastSeenAt on the ones that were. Idempotent; safe per turn.
	Index(ctx context.Context, tools []Descriptor) error

	// Search ranks tools by similarity to text and returns the best k,
	// restricted to the given set.
	//
	// Implementations MUST NOT return a definition whose hash is not in tools.
	// That restriction is what makes cross-caller leakage structurally
	// impossible, and is the reason this store needs no RBAC filter.
	Search(ctx context.Context, text string, tools []Descriptor, k int) ([]Descriptor, error)

	// Prune drops definitions not seen within the retention window. Qdrant has
	// no native TTL, so this is swept periodically rather than expiring on its
	// own.
	Prune(ctx context.Context, olderThanSeconds int64) (int, error)
}

// Resolve decides WHICH of a caller's tools reach the planner.
//
// The ordering is the whole point. Retrieval is only worth its cost when there
// is something to prune, so a caller sending a handful of tools pays nothing:
// no embedding, no vector round trip, no added latency on the hot path. Only a
// caller with a large array — the case that would otherwise drown a Skill's own
// 1–5 declared tools in the planner's prompt — gets indexed and ranked.
func Resolve(
	ctx context.Context,
	request string,
	tools []Descriptor,
	choice Choice,
	topK int,
	store Store,
) []Descriptor {
	if choice.Kind == ChoiceNone || len(tools) == 0 {
		return nil
	}

	// A named choice IS a selection. Ranking one candidate against itself
	// would be pure overhead, and offering the others would contradict the
	// caller's explicit instruction.
	if choice.Kind == ChoiceFunction {
		for _, tool := range tools {
			if tool.Name == choice.Name {
				return []Descriptor{tool}
			}
		}
		return nil
	}

	// Nothing to prune: every tool already fits the planner's budget.
	if len(tools) <= topK {
		return tools
	}

	if store == nil {
		// Degrade to truncation rather than dropping the feature: the caller
		// still gets tool calling, just without relevance ranking.
		log.Printf("caller-tool store not configured; truncating %d tools to %d without ranking", len(tools), topK)
		return tools[:topK]
	}

	if err := store.Index(ctx, tools); err != nil {
		log.Printf("caller-tool indexing failed; truncating without ranking: %v", err)
		return tools[:topK]
	}
	ranked, err := store.Search(ctx, request, tools, topK)
	if err != nil {
		log.Printf("caller-tool retrieval failed; truncating without ranking: %v", err)
		return tools[:topK]
	}
	if len(ranked) == 0 {
		// An empty result from a healthy store would mean the request matched
		// nothing, but it also happens if the points went missing between index
		// and search. Truncation is the safer read: "the caller offered 40
		// tools and none were even considered" is the worse failure.
		return tools[:topK]
	}
	return ranked
}
