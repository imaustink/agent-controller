package vectorstore

import (
	"context"
	"fmt"

	"github.com/qdrant/go-client/qdrant"
)

// Collections groups the three catalog stores, mirroring agent-controller's
// parallel Qdrant collections.
type Collections struct {
	Tools  Store
	Skills Store
	Agents Store
}

// OpenCollections dials Qdrant and returns the three stores, creating any
// missing collections. A non-empty prefix namespaces the collections (e.g.
// "da-" → da-tools/da-skills/da-agents) so this system can share a Qdrant
// instance with another indexer — payload schemas differ, so collections
// must never be shared. Close the returned client when done.
func OpenCollections(ctx context.Context, host string, port int, embedder Embedder, dims uint64, prefix string) (*qdrant.Client, Collections, error) {
	client, err := qdrant.NewClient(&qdrant.Config{Host: host, Port: port})
	if err != nil {
		return nil, Collections{}, fmt.Errorf("dial qdrant at %s:%d: %w", host, port, err)
	}

	collections := Collections{
		Tools:  NewQdrant(client, prefix+"tools", embedder, dims),
		Skills: NewQdrant(client, prefix+"skills", embedder, dims),
		Agents: NewQdrant(client, prefix+"agents", embedder, dims),
	}
	for _, s := range []*Qdrant{
		collections.Tools.(*Qdrant),
		collections.Skills.(*Qdrant),
		collections.Agents.(*Qdrant),
	} {
		if err := s.EnsureCollection(ctx); err != nil {
			_ = client.Close()
			return nil, Collections{}, err
		}
	}
	return client, collections, nil
}
