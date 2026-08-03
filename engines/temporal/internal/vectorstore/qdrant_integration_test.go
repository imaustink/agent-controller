package vectorstore_test

import (
	"context"
	"encoding/json"
	"hash/fnv"
	"os"
	"strconv"
	"strings"
	"testing"

	"github.com/qdrant/go-client/qdrant"
	"github.com/stretchr/testify/require"

	"durable-agents/internal/vectorstore"
)

// fakeEmbedder is deterministic: same text, same vector. Good enough to
// exercise upsert/query/filter mechanics against a real Qdrant.
type fakeEmbedder struct{}

func (fakeEmbedder) Embed(_ context.Context, inputs []string) ([][]float32, error) {
	out := make([][]float32, len(inputs))
	for i, text := range inputs {
		vec := make([]float32, 8)
		for _, word := range strings.Fields(strings.ToLower(text)) {
			h := fnv.New32a()
			_, _ = h.Write([]byte(word))
			vec[h.Sum32()%8] += 1
		}
		out[i] = vec
	}
	return out, nil
}

// Requires a live Qdrant, e.g.:
//
//	docker run -d --rm -p 6334:6334 qdrant/qdrant
//	QDRANT_TEST_ADDR=127.0.0.1:6334 go test ./internal/vectorstore/
func TestQdrantStoreIntegration(t *testing.T) {
	addr := os.Getenv("QDRANT_TEST_ADDR")
	if addr == "" {
		t.Skip("QDRANT_TEST_ADDR not set; skipping Qdrant integration test")
	}
	host, portStr, ok := strings.Cut(addr, ":")
	require.True(t, ok, "QDRANT_TEST_ADDR must be host:port")
	port, err := strconv.Atoi(portStr)
	require.NoError(t, err)

	client, err := qdrant.NewClient(&qdrant.Config{Host: host, Port: port})
	require.NoError(t, err)
	t.Cleanup(func() { _ = client.Close() })

	ctx := context.Background()
	collection := "durable-agents-test"
	_ = client.DeleteCollection(ctx, collection)
	store := vectorstore.NewQdrant(client, collection, fakeEmbedder{}, 8)
	require.NoError(t, store.EnsureCollection(ctx))
	require.NoError(t, store.EnsureCollection(ctx), "ensure must be idempotent")

	descriptor := func(id string) json.RawMessage {
		return json.RawMessage(`{"id":"` + id + `"}`)
	}
	require.NoError(t, store.Upsert(ctx, []vectorstore.Record{
		{ID: "scraper", Text: "scrape recipes from urls", Roles: []string{"cook", "admin"}, Descriptor: descriptor("scraper")},
		{ID: "deployer", Text: "deploy services to kubernetes", Roles: []string{"admin"}, Descriptor: descriptor("deployer")},
		{ID: "chitchat", Text: "general conversation", Unrestricted: true, Descriptor: descriptor("chitchat")},
	}))

	t.Run("query filters by role", func(t *testing.T) {
		hits, err := store.Query(ctx, "scrape a recipe", []string{"cook"}, 10)
		require.NoError(t, err)
		ids := hitIDs(hits)
		require.Contains(t, ids, "scraper")
		require.Contains(t, ids, "chitchat") // unrestricted always visible
		require.NotContains(t, ids, "deployer")
	})

	t.Run("no roles fails closed to unrestricted only", func(t *testing.T) {
		hits, err := store.Query(ctx, "deploy something", nil, 10)
		require.NoError(t, err)
		require.Equal(t, []string{"chitchat"}, hitIDs(hits))
	})

	t.Run("get by ids re-checks roles", func(t *testing.T) {
		hits, err := store.GetByIDs(ctx, []string{"scraper", "deployer", "chitchat", "missing"}, []string{"cook"})
		require.NoError(t, err)
		ids := hitIDs(hits)
		require.ElementsMatch(t, []string{"scraper", "chitchat"}, ids)
	})

	t.Run("descriptor round-trips", func(t *testing.T) {
		hits, err := store.GetByIDs(ctx, []string{"scraper"}, []string{"cook"})
		require.NoError(t, err)
		require.Len(t, hits, 1)
		require.JSONEq(t, `{"id":"scraper"}`, string(hits[0].Descriptor))
	})

	t.Run("delete removes the record", func(t *testing.T) {
		require.NoError(t, store.Delete(ctx, []string{"scraper"}))
		hits, err := store.GetByIDs(ctx, []string{"scraper"}, []string{"cook", "admin"})
		require.NoError(t, err)
		require.Empty(t, hits)
	})
}

func hitIDs(hits []vectorstore.Hit) []string {
	ids := make([]string, len(hits))
	for i, h := range hits {
		ids[i] = h.ID
	}
	return ids
}
