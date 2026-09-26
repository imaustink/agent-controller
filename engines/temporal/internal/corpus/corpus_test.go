package corpus_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// fakeStore is one member collection. It records the roles it was queried with
// so the fan-out's fail-closed behaviour can be asserted, and can be made to
// fail to exercise partial degradation.
type fakeStore struct {
	hits []vectorstore.Hit
	err  error

	mu         sync.Mutex
	queriedFor [][]string
}

func (f *fakeStore) Query(_ context.Context, _ string, callerRoles []string, limit int) ([]vectorstore.Hit, error) {
	f.mu.Lock()
	f.queriedFor = append(f.queriedFor, callerRoles)
	f.mu.Unlock()

	if f.err != nil {
		return nil, f.err
	}
	// A real store returns the top-k BY SCORE, not the first k it happens to
	// hold, and the fan-out's pruning depends on that.
	ranked := append([]vectorstore.Hit(nil), f.hits...)
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Score > ranked[j].Score })
	if len(ranked) > limit {
		ranked = ranked[:limit]
	}
	return ranked, nil
}

func (f *fakeStore) Upsert(context.Context, []vectorstore.Record) error { return nil }
func (f *fakeStore) Delete(context.Context, []string) error             { return nil }
func (f *fakeStore) GetByIDs(context.Context, []string, []string) ([]vectorstore.Hit, error) {
	return nil, nil
}
func (f *fakeStore) GetByIDsUnfiltered(context.Context, []string) ([]vectorstore.Hit, error) {
	return nil, nil
}

func chunkHit(connectionID, sourceID, hash string, score float32) vectorstore.Hit {
	payload, err := json.Marshal(corpus.Chunk{
		CorpusID:    connectionID,
		CorpusLabel: "#" + connectionID,
		SourceURL:   fmt.Sprintf("https://example.test/%s/%s", connectionID, sourceID),
		SourceID:    sourceID,
		ContentHash: hash,
		Text:        "…" + sourceID + "…",
	})
	if err != nil {
		panic(err)
	}
	return vectorstore.Hit{ID: hash, Score: score, Descriptor: payload}
}

func TestSearchMergesMembersByScore(t *testing.T) {
	confluence := &fakeStore{hits: []vectorstore.Hit{
		chunkHit("snc-confluence", "page-1", "hash-a", 0.91),
		chunkHit("snc-confluence", "page-2", "hash-b", 0.42),
	}}
	slack := &fakeStore{hits: []vectorstore.Hit{
		chunkHit("snc-slack-eng", "msg-1", "hash-c", 0.77),
	}}

	hits, skipped, err := corpus.Search(context.Background(),
		[]vectorstore.Store{confluence, slack}, "how is auth configured", []string{"reader"}, 10)

	require.NoError(t, err)
	require.Zero(t, skipped)
	require.Len(t, hits, 3)
	require.Equal(t, "hash-a", hits[0].Chunk.ContentHash, "highest score first, across members")
	require.Equal(t, "hash-c", hits[1].Chunk.ContentHash)
	require.Equal(t, "hash-b", hits[2].Chunk.ContentHash)
}

func TestSearchPassesCallerRolesToEveryMember(t *testing.T) {
	first, second := &fakeStore{}, &fakeStore{}

	_, _, err := corpus.Search(context.Background(),
		[]vectorstore.Store{first, second}, "q", []string{"reader", "lead"}, 5)

	require.NoError(t, err)
	// Per-point filtering is defense in depth behind the source-level filter,
	// so the roles must reach every member rather than being trusted to have
	// been applied upstream.
	require.Equal(t, [][]string{{"reader", "lead"}}, first.queriedFor)
	require.Equal(t, [][]string{{"reader", "lead"}}, second.queriedFor)
}

func TestSearchDeduplicatesTheSamePassageReachedTwice(t *testing.T) {
	// The same document in a Drive folder and linked into a synced Confluence
	// space: one fact, two connections, one content hash.
	drive := &fakeStore{hits: []vectorstore.Hit{chunkHit("snc-drive", "doc-7", "same-hash", 0.55)}}
	confluence := &fakeStore{hits: []vectorstore.Hit{chunkHit("snc-confluence", "page-9", "same-hash", 0.81)}}

	hits, _, err := corpus.Search(context.Background(),
		[]vectorstore.Store{drive, confluence}, "q", []string{"reader"}, 10)

	require.NoError(t, err)
	require.Len(t, hits, 1, "a cited answer must not list two URLs for one fact")
	require.Equal(t, "snc-confluence", hits[0].Chunk.CorpusID, "the better-scoring copy wins")
}

func TestSearchIsDeterministicAcrossRuns(t *testing.T) {
	// Identical scores from a parallel fan-out have no meaningful arrival
	// order, so the tiebreak must not depend on which goroutine finished first.
	build := func() []vectorstore.Store {
		return []vectorstore.Store{
			&fakeStore{hits: []vectorstore.Hit{chunkHit("bbb", "s1", "h1", 0.5)}},
			&fakeStore{hits: []vectorstore.Hit{chunkHit("aaa", "s2", "h2", 0.5)}},
			&fakeStore{hits: []vectorstore.Hit{chunkHit("ccc", "s3", "h3", 0.5)}},
		}
	}

	first, _, err := corpus.Search(context.Background(), build(), "q", []string{"reader"}, 10)
	require.NoError(t, err)

	for i := 0; i < 20; i++ {
		again, _, err := corpus.Search(context.Background(), build(), "q", []string{"reader"}, 10)
		require.NoError(t, err)
		require.Equal(t, first, again, "the same question twice must cite the same sources")
	}
}

func TestSearchPrunesToTheLimit(t *testing.T) {
	hits := make([]vectorstore.Hit, 0, 8)
	for i := 0; i < 8; i++ {
		hits = append(hits, chunkHit("c", fmt.Sprintf("s%d", i), fmt.Sprintf("h%d", i), float32(i)/10))
	}

	got, _, err := corpus.Search(context.Background(),
		[]vectorstore.Store{&fakeStore{hits: hits}}, "q", []string{"reader"}, 3)

	require.NoError(t, err)
	require.Len(t, got, 3)
	require.Equal(t, "h7", got[0].Chunk.ContentHash, "the best survive the prune")
}

func TestSearchDegradesWhenOneMemberFails(t *testing.T) {
	healthy := &fakeStore{hits: []vectorstore.Hit{chunkHit("ok", "s1", "h1", 0.6)}}
	broken := &fakeStore{err: errors.New("qdrant unreachable")}

	hits, skipped, err := corpus.Search(context.Background(),
		[]vectorstore.Store{healthy, broken}, "q", []string{"reader"}, 10)

	require.NoError(t, err, "one unreachable member must not fail the whole knowledge base")
	require.Equal(t, 1, skipped, "but the caller has to be able to say part of it was missed")
	require.Len(t, hits, 1)
}

func TestSearchFailsWhenEveryMemberFails(t *testing.T) {
	broken := func() *fakeStore { return &fakeStore{err: errors.New("qdrant unreachable")} }

	_, skipped, err := corpus.Search(context.Background(),
		[]vectorstore.Store{broken(), broken()}, "q", []string{"reader"}, 10)

	// Returning "no results" here would be a confident lie about the client's
	// material, which is worse than an error.
	require.Error(t, err)
	require.Equal(t, 2, skipped)
}

func TestSearchRejectsANonPositiveLimit(t *testing.T) {
	_, _, err := corpus.Search(context.Background(),
		[]vectorstore.Store{&fakeStore{}}, "q", []string{"reader"}, 0)
	require.Error(t, err)
}

func TestSearchWithNoVisibleMembersReturnsNothing(t *testing.T) {
	hits, skipped, err := corpus.Search(context.Background(), nil, "q", []string{"reader"}, 10)
	require.NoError(t, err)
	require.Zero(t, skipped)
	require.Empty(t, hits)
}
