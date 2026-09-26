// Package corpus searches the per-Corpus collections a KnowledgeBase
// composes (agent-controller ADR 0039).
//
// The catalog collections answer "which capability fits this turn?". A corpus
// answers "what do we know about this client?", over ordinary documents rather
// than descriptors. Both sit behind vectorstore.Store; what differs is that a
// knowledge base's material is spread across one collection per member
// Connection, so a search is a fan-out and a merge rather than a single query.
package corpus

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"

	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// Chunk is one indexed passage: the payload stored alongside a corpus point.
//
// Provenance travels with every chunk because a knowledge-base answer is
// required to cite. A chunk that reached the planner without a SourceURL cannot
// be cited, and an uncited claim about a client's material is not an acceptable
// answer.
type Chunk struct {
	// CorpusID is the member Corpus this came from, and
	// CorpusLabel is what a citation renders (two Slack channels in one
	// knowledge base are distinguishable only by this).
	CorpusID    string `json:"connectionId"`
	CorpusLabel string `json:"connectionLabel,omitempty"`

	SourceURL string `json:"sourceUrl"`
	SourceID  string `json:"sourceId"`
	Title     string `json:"title,omitempty"`

	// UpdatedAt is when the SOURCE last changed, RFC 3339. Carried so an answer
	// can admit how old its evidence is.
	UpdatedAt string `json:"updatedAt,omitempty"`

	// ContentHash is a sha256 over the normalized chunk text. It doubles as the
	// point id (ADR 0039 §7), which is what makes a re-sync re-embed only what
	// changed, and it is how the same document reached through two Connections
	// is de-duplicated at merge.
	ContentHash string `json:"contentHash"`

	// Version of the SOURCE this chunk was built from. Compared against the
	// probe's version (ADR 0040) to tell whether the indexed passage has been
	// overtaken; carried rather than derived because only the driver knows what
	// a version means for its provider.
	Version string `json:"version,omitempty"`

	Text string `json:"text"`

	// ACLPrincipals is the MIRROR of the source's read restrictions, captured
	// at ingest — provider-shaped strings like "user:<accountId>" or
	// "group:<id>" (ADR 0040).
	//
	// It exists to make retrieval cheaper, never to decide access. It is a
	// snapshot of permissions that may have changed a second after it was
	// taken, and the source is asked again, per user, before anything here is
	// shown. Treating it as authoritative would mean serving a permission
	// decision from a cache nobody revalidated.
	ACLPrincipals []string `json:"aclPrincipals,omitempty"`

	// ACLPermissive marks a chunk whose effective permissions the driver could
	// not resolve, so ACLPrincipals is not a usable exclusion set.
	//
	// Set deliberately rather than inferred from an empty list, because the two
	// mean opposite things: an empty list on a non-permissive chunk is "nobody
	// is specially granted", while permissive is "we do not know, so do not use
	// this to exclude anyone".
	ACLPermissive bool `json:"aclPermissive,omitempty"`
}

// Hit is a chunk with the score it matched at.
type Hit struct {
	Chunk Chunk
	Score float32
}

// Search fans out across a knowledge base's member collections and merges the
// results.
//
// Queries run in parallel: a knowledge base of eight members should cost one
// round trip's latency, not eight. Scores are directly comparable because every
// corpus shares one embedder and cosine distance, which is what makes merging
// by score meaningful rather than approximate.
//
// Partial failure degrades rather than fails. One unreachable collection must
// not take a whole knowledge base down with it, so a failing member is counted
// and skipped — but if EVERY member fails, that is a broken search, and
// reporting "nothing found" would be a confident lie. The caller is told how
// many were skipped so it can say so.
func Search(
	ctx context.Context,
	stores []vectorstore.Store,
	query string,
	callerRoles []string,
	limit int,
) (hits []Hit, skipped int, err error) {
	if limit <= 0 {
		return nil, 0, fmt.Errorf("corpus search limit must be positive, got %d", limit)
	}
	if len(stores) == 0 {
		return nil, 0, nil
	}

	var (
		mu       sync.Mutex
		gathered []Hit
		firstErr error
		wg       sync.WaitGroup
	)

	for _, store := range stores {
		wg.Add(1)
		go func(store vectorstore.Store) {
			defer wg.Done()

			// Each member is asked for `limit` on the assumption that one of
			// them could supply the whole answer; the merge below prunes back
			// to `limit` overall.
			found, queryErr := store.Query(ctx, query, callerRoles, limit)

			mu.Lock()
			defer mu.Unlock()
			if queryErr != nil {
				skipped++
				if firstErr == nil {
					firstErr = queryErr
				}
				return
			}
			for _, hit := range found {
				chunk, decodeErr := decodeChunk(hit)
				if decodeErr != nil {
					// One malformed payload is not worth failing a search over,
					// but it must not be silently answered from either.
					if firstErr == nil {
						firstErr = decodeErr
					}
					continue
				}
				gathered = append(gathered, Hit{Chunk: chunk, Score: hit.Score})
			}
		}(store)
	}
	wg.Wait()

	if skipped == len(stores) {
		return nil, skipped, fmt.Errorf("every corpus in this knowledge base failed: %w", firstErr)
	}
	return prune(gathered, limit), skipped, nil
}

// prune de-duplicates by content hash and returns the best `limit` hits.
//
// The same passage can legitimately arrive twice — a document in a Drive folder
// that is also linked into a synced Confluence space, say. Keeping both would
// spend the answer's budget saying one thing twice, and would make a cited
// answer list two URLs for one fact.
//
// Ties are broken deterministically (higher score, then connection id, then
// source id) rather than by arrival order. A parallel fan-out has no meaningful
// "first", and a stable order means the same question twice does not produce
// two differently-cited answers.
func prune(hits []Hit, limit int) []Hit {
	best := make(map[string]Hit, len(hits))
	for _, hit := range hits {
		key := hit.Chunk.ContentHash
		if key == "" {
			// No hash to dedupe on: fall back to source identity so a chunk is
			// not silently dropped for being unhashed.
			key = hit.Chunk.CorpusID + "\x00" + hit.Chunk.SourceID
		}
		existing, seen := best[key]
		if !seen || betterThan(hit, existing) {
			best[key] = hit
		}
	}

	merged := make([]Hit, 0, len(best))
	for _, hit := range best {
		merged = append(merged, hit)
	}
	sort.Slice(merged, func(i, j int) bool { return betterThan(merged[i], merged[j]) })

	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

func betterThan(a, b Hit) bool {
	if a.Score != b.Score {
		return a.Score > b.Score
	}
	if a.Chunk.CorpusID != b.Chunk.CorpusID {
		return a.Chunk.CorpusID < b.Chunk.CorpusID
	}
	return a.Chunk.SourceID < b.Chunk.SourceID
}

func decodeChunk(hit vectorstore.Hit) (Chunk, error) {
	var chunk Chunk
	if err := json.Unmarshal(hit.Descriptor, &chunk); err != nil {
		return Chunk{}, fmt.Errorf("decode corpus chunk %s: %w", hit.ID, err)
	}
	return chunk, nil
}
