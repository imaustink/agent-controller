package vectorstore

import (
	"context"
	"fmt"
	"sync"

	"github.com/qdrant/go-client/qdrant"
)

// Corpora is the per-Connection half of the vector store.
//
// The three catalog collections (tools/skills/agents) are fixed and opened once
// at startup. Corpus collections are not: there is one per Connection CR
// (ADR 0039 §1), they appear and disappear with those CRs, and which ones a
// query touches is decided per request by the KnowledgeBase being searched.
//
// Storage is per-Connection rather than per-KnowledgeBase so that a Connection
// shared by several knowledge bases is embedded once, and composing or
// recomposing a knowledge base is a metadata change that costs no re-indexing.
// The price is a fan-out at query time, which the caller performs across the
// Stores this registry hands out.
type Corpora struct {
	client   *qdrant.Client
	embedder Embedder
	dims     uint64

	mu     sync.Mutex
	stores map[string]Store
}

// NewCorpora returns a registry over an already-dialled Qdrant client. It
// shares the client, embedder and vector size with the catalog collections, so
// scores from a corpus are directly comparable with each other — which is what
// makes merging a fan-out by score meaningful.
func NewCorpora(client *qdrant.Client, embedder Embedder, dims uint64) *Corpora {
	return &Corpora{
		client:   client,
		embedder: embedder,
		dims:     dims,
		stores:   map[string]Store{},
	}
}

// For returns the Store for one collection, creating the collection on first
// use and caching the Store afterwards.
//
// Creating on read rather than up front matters for ordering: a Connection's
// collection name is published by its controller, and an indexer may reach a
// corpus before anything has been written to it. An empty collection answering
// "no hits" is the correct behaviour for a knowledge base whose member has not
// synced yet — better than an error that would fail the whole fan-out and take
// its healthy siblings down too.
func (c *Corpora) For(ctx context.Context, collection string) (Store, error) {
	if collection == "" {
		return nil, fmt.Errorf("corpus collection name is empty")
	}

	c.mu.Lock()
	store, ok := c.stores[collection]
	c.mu.Unlock()
	if ok {
		return store, nil
	}

	qdrantStore := NewQdrant(c.client, collection, c.embedder, c.dims)
	if err := qdrantStore.EnsureCollection(ctx); err != nil {
		return nil, err
	}

	c.mu.Lock()
	defer c.mu.Unlock()
	// Another goroutine may have won the race while we were ensuring; keep
	// whichever landed first so callers always share one Store per collection.
	if existing, ok := c.stores[collection]; ok {
		return existing, nil
	}
	c.stores[collection] = qdrantStore
	return qdrantStore, nil
}

// Resolve returns the Stores for several collections at once, skipping any that
// cannot be opened and reporting how many were skipped.
//
// A fan-out is partial-failure tolerant by design: one unreachable corpus must
// degrade a knowledge base to its remaining members rather than fail the
// search. The skipped count is returned rather than swallowed so the caller can
// tell the difference between "nothing matched" and "some of this knowledge
// base could not be consulted" — the same honesty the role-filtering path owes
// a caller (ADR 0039 §4), for a different reason.
func (c *Corpora) Resolve(ctx context.Context, collections []string) ([]Store, int, error) {
	stores := make([]Store, 0, len(collections))
	skipped := 0
	var firstErr error

	for _, collection := range collections {
		store, err := c.For(ctx, collection)
		if err != nil {
			skipped++
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		stores = append(stores, store)
	}

	// Every corpus failing is not a degraded search, it is a broken one —
	// answering "nothing found" then would be a confident lie.
	if len(stores) == 0 && len(collections) > 0 {
		return nil, skipped, fmt.Errorf("no corpus collection could be opened: %w", firstErr)
	}
	return stores, skipped, nil
}

// Forget drops a collection's cached Store, so a Connection that goes away
// stops holding one.
//
// It deliberately does NOT delete the collection. A collection may be reachable
// from several knowledge bases, and the decision to destroy indexed data
// belongs to the Connection's own lifecycle rather than to a cache eviction.
func (c *Corpora) Forget(collection string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.stores, collection)
}
