package corpus

import (
	"context"

	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// Retrieve is the whole read path for a knowledge base: fan out, merge, probe,
// and hand back only what the source confirmed this caller may read.
//
// The two halves answer different questions and neither substitutes for the
// other. The mirror decides what is WORTH asking about — cheap, approximate,
// and deliberately biased toward over-inclusion. The source decides what may be
// SEEN, per user, at query time. ADR 0040's governing rule is that the first is
// never allowed to stand in for the second.
//
// Over-fetching is what keeps that affordable without starving the answer: ask
// for `limit * multiplier` candidates so probe drops have slack to come out of,
// then return at most `limit`.
func Retrieve(
	ctx context.Context,
	stores []vectorstore.Store,
	prober Prober,
	query string,
	callerRoles []string,
	limit int,
	multiplier int,
) (RetrieveOutcome, error) {
	if multiplier < 1 {
		multiplier = DefaultCandidateMultiplier
	}

	candidates, skipped, err := Search(ctx, stores, query, callerRoles, limit*multiplier)
	if err != nil {
		return RetrieveOutcome{}, err
	}

	authorized, err := Authorize(ctx, prober, candidates)
	if err != nil {
		return RetrieveOutcome{}, err
	}

	chunks := authorized.Chunks
	if len(chunks) > limit {
		chunks = chunks[:limit]
	}

	return RetrieveOutcome{
		Chunks:         chunks,
		Denied:         authorized.Denied,
		Undetermined:   authorized.Undetermined,
		SkippedCorpora: skipped,
	}, nil
}
