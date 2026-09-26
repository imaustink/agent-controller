package corpus

import (
	"context"
	"fmt"

	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// SampleResult is one canned query's answer about the ACL mirror's accuracy.
type SampleResult struct {
	Query string

	// Candidates is how many the search returned before any filtering.
	Candidates int

	// PreFiltered is how many the mirror excluded. Expected and healthy; this
	// is the saving the mirror exists to produce.
	PreFiltered int

	// HarmfulMisses is the number the mirror excluded that the SOURCE then said
	// this user may read.
	//
	// The number this whole job exists to produce. Every other signal in the
	// system is visible by default — a wasted probe shows up as latency, a
	// denial shows up in the drop rate — but a result wrongly withheld is
	// invisible, because nobody reports the answer they never saw. It should be
	// zero, and anything else means the mirror is excluding on information it
	// does not actually have.
	HarmfulMisses []string

	// WastedProbes is the opposite direction: kept by the mirror, refused by
	// the source. Harmless, and reported because it is what the mirror's
	// optimism costs.
	WastedProbes int
}

// SampleConfig is one test principal and the queries to ask as them.
type SampleConfig struct {
	// Roles and Principals are a REAL test user's, not a synthetic superset.
	// A principal set nobody actually holds would measure a filter nobody is
	// ever subject to.
	Roles      []string
	Principals []string
	Queries    []string
	Limit      int
}

// Sample measures the ACL mirror in the direction that cannot report itself
// (ADR 0040, Observability).
//
// It runs each query TWICE against the same corpora: once through the
// pre-filter, once bypassing it. Both arms are then probed with the same test
// user's own token, so anything the source allows but the pre-filter excluded
// is a harmful-direction miss.
//
// Deliberately requires no privileged access. It runs entirely as the test
// principal, which is what makes it safe to schedule: a job that needed an
// elevated credential to audit an authorization boundary would be a new way to
// cross that boundary.
func Sample(
	ctx context.Context,
	stores []vectorstore.Store,
	prober Prober,
	cfg SampleConfig,
) ([]SampleResult, error) {
	if len(cfg.Queries) == 0 {
		return nil, nil
	}
	limit := cfg.Limit
	if limit <= 0 {
		limit = 10
	}

	results := make([]SampleResult, 0, len(cfg.Queries))
	for _, query := range cfg.Queries {
		candidates, _, err := Search(ctx, stores, query, cfg.Roles, limit*DefaultCandidateMultiplier)
		if err != nil {
			return nil, fmt.Errorf("sample %q: %w", query, err)
		}

		kept, dropped := PreFilter(candidates, cfg.Principals)

		// The control arm: everything the mirror excluded, asked of the source
		// directly. This is the only way to see the harmful direction, because
		// the production path never asks about these at all.
		excluded := difference(candidates, kept)

		result := SampleResult{Query: query, Candidates: len(candidates), PreFiltered: dropped}

		if len(excluded) > 0 {
			authorized, err := Authorize(ctx, prober, excluded)
			if err != nil {
				return nil, fmt.Errorf("sample %q control arm: %w", query, err)
			}
			for _, chunk := range authorized.Chunks {
				// Allowed by the source, withheld by the mirror. The user would
				// have been told this does not exist.
				result.HarmfulMisses = append(result.HarmfulMisses, chunk.Chunk.SourceURL)
			}
		}

		if len(kept) > 0 {
			authorized, err := Authorize(ctx, prober, kept)
			if err != nil {
				return nil, fmt.Errorf("sample %q treatment arm: %w", query, err)
			}
			result.WastedProbes = authorized.Denied
		}

		results = append(results, result)
	}

	return results, nil
}

// difference returns the hits in all that are absent from kept.
//
// Identity is the content hash, which is the point id: two chunks with the same
// text from the same source ARE the same chunk, and comparing by pointer would
// make a deduplicated merge look like an exclusion.
func difference(all, kept []Hit) []Hit {
	keptHashes := make(map[string]struct{}, len(kept))
	for _, hit := range kept {
		keptHashes[hit.Chunk.ContentHash] = struct{}{}
	}

	excluded := make([]Hit, 0, len(all)-len(kept))
	for _, hit := range all {
		if _, ok := keptHashes[hit.Chunk.ContentHash]; !ok {
			excluded = append(excluded, hit)
		}
	}
	return excluded
}

// HarmfulMissRate is the fraction of sampled candidates that were wrongly
// withheld. It is the number to alert on; anything above zero means callers are
// being told material does not exist.
func HarmfulMissRate(results []SampleResult) float64 {
	var candidates, misses int
	for _, result := range results {
		candidates += result.Candidates
		misses += len(result.HarmfulMisses)
	}
	if candidates == 0 {
		return 0
	}
	return float64(misses) / float64(candidates)
}
