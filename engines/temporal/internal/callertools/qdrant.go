package callertools

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/qdrant/go-client/qdrant"
)

// Embedder is satisfied by *llm.Embedder.
type Embedder interface {
	Embed(ctx context.Context, inputs []string) ([][]float32, error)
}

// QdrantStore indexes caller tools in their own collection, keyed by content
// hash.
//
// The keying is what makes this affordable. Identical definitions embed once,
// ever, across all callers and all turns — and since a given client sends a
// near-identical tool array every single turn, the steady-state embedding cost
// of the whole feature is zero. That is what makes "vectorize just in time"
// viable: the JIT cost is paid on first sight of a definition, not per request.
//
// Content-hash keying does mean a shared cache is a shared NAMESPACE. A caller
// learns nothing from it — they can only retrieve by hashes they computed from
// definitions they already hold — but two callers using the same definition do
// share one point. This is the design's least conventional decision and is
// called out as such upstream.
type QdrantStore struct {
	client     *qdrant.Client
	collection string
	embedder   Embedder
	dims       uint64
}

func NewQdrantStore(client *qdrant.Client, collection string, embedder Embedder, dims uint64) *QdrantStore {
	return &QdrantStore{client: client, collection: collection, embedder: embedder, dims: dims}
}

func (s *QdrantStore) EnsureCollection(ctx context.Context) error {
	exists, err := s.client.CollectionExists(ctx, s.collection)
	if err != nil {
		return fmt.Errorf("check collection %s: %w", s.collection, err)
	}
	if exists {
		return nil
	}
	if err := s.client.CreateCollection(ctx, &qdrant.CreateCollection{
		CollectionName: s.collection,
		VectorsConfig: qdrant.NewVectorsConfig(&qdrant.VectorParams{
			Size:     s.dims,
			Distance: qdrant.Distance_Cosine,
		}),
	}); err != nil {
		return fmt.Errorf("create collection %s: %w", s.collection, err)
	}
	return nil
}

// pointID derives a stable UUID from the content hash. Qdrant point ids must
// be UUIDs or integers; the hash itself also rides the payload.
func (s *QdrantStore) pointID(hash string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("github.com/controller-agent/temporal-engine/callertools/"+hash)).String()
}

// embeddingText is what gets vectorized. Name and description only: a JSON
// Schema is structure, not meaning, and embedding it would let a large schema's
// field names dominate the similarity of a tool whose actual purpose is one
// line of prose.
func embeddingText(t Descriptor) string {
	if t.Description == "" {
		return t.Name
	}
	return t.Name + ": " + t.Description
}

func (s *QdrantStore) Index(ctx context.Context, tools []Descriptor) error {
	if len(tools) == 0 {
		return nil
	}
	now := time.Now().Unix()

	// Which are already present? Only misses need embedding — the round trip
	// that this lookup saves is the entire point of the content-hash key.
	present, err := s.existing(ctx, tools)
	if err != nil {
		return err
	}

	var misses []Descriptor
	var touch []*qdrant.PointId
	for _, tool := range tools {
		if present[tool.Hash] {
			touch = append(touch, qdrant.NewIDUUID(s.pointID(tool.Hash)))
			continue
		}
		misses = append(misses, tool)
	}

	// Refresh lastSeenAt on the hits so Prune does not reclaim a definition
	// that is still in active use.
	if len(touch) > 0 {
		wait := true
		if _, err := s.client.SetPayload(ctx, &qdrant.SetPayloadPoints{
			CollectionName: s.collection,
			Payload:        qdrant.NewValueMap(map[string]any{"lastSeenAt": now}),
			PointsSelector: qdrant.NewPointsSelector(touch...),
			Wait:           &wait,
		}); err != nil {
			// Not fatal: a missed touch only risks an early prune of a
			// definition that will simply be re-indexed on its next use.
			return fmt.Errorf("refresh lastSeenAt on %d caller tools: %w", len(touch), err)
		}
	}

	if len(misses) == 0 {
		return nil
	}

	texts := make([]string, len(misses))
	for i, tool := range misses {
		texts[i] = embeddingText(tool)
	}
	vectors, err := s.embedder.Embed(ctx, texts)
	if err != nil {
		return fmt.Errorf("embed %d caller tools: %w", len(misses), err)
	}

	points := make([]*qdrant.PointStruct, len(misses))
	for i, tool := range misses {
		descriptor, err := json.Marshal(tool)
		if err != nil {
			return fmt.Errorf("marshal caller tool %s: %w", tool.Name, err)
		}
		points[i] = &qdrant.PointStruct{
			Id:      qdrant.NewIDUUID(s.pointID(tool.Hash)),
			Vectors: qdrant.NewVectors(vectors[i]...),
			Payload: qdrant.NewValueMap(map[string]any{
				"hash":       tool.Hash,
				"descriptor": string(descriptor),
				"lastSeenAt": now,
			}),
		}
	}
	wait := true
	if _, err := s.client.Upsert(ctx, &qdrant.UpsertPoints{
		CollectionName: s.collection,
		Points:         points,
		Wait:           &wait,
	}); err != nil {
		return fmt.Errorf("upsert %d caller tools: %w", len(points), err)
	}
	return nil
}

func (s *QdrantStore) existing(ctx context.Context, tools []Descriptor) (map[string]bool, error) {
	ids := make([]*qdrant.PointId, len(tools))
	for i, tool := range tools {
		ids[i] = qdrant.NewIDUUID(s.pointID(tool.Hash))
	}
	points, err := s.client.Get(ctx, &qdrant.GetPoints{
		CollectionName: s.collection,
		Ids:            ids,
		WithPayload:    qdrant.NewWithPayload(true),
	})
	if err != nil {
		return nil, fmt.Errorf("look up %d caller tools: %w", len(ids), err)
	}
	present := make(map[string]bool, len(points))
	for _, p := range points {
		if hash := p.GetPayload()["hash"].GetStringValue(); hash != "" {
			present[hash] = true
		}
	}
	return present, nil
}

func (s *QdrantStore) Search(ctx context.Context, text string, tools []Descriptor, k int) ([]Descriptor, error) {
	if len(tools) == 0 || k <= 0 {
		return nil, nil
	}
	vectors, err := s.embedder.Embed(ctx, []string{text})
	if err != nil {
		return nil, fmt.Errorf("embed caller-tool query: %w", err)
	}

	// The filter is restricted to hashes taken from THIS request's body. That
	// is what makes cross-caller leakage structurally impossible, and it is why
	// this collection needs no RBAC payload filter — retrieval can never range
	// over definitions the request did not itself supply.
	limit := uint64(k)
	points, err := s.client.Query(ctx, &qdrant.QueryPoints{
		CollectionName: s.collection,
		Query:          qdrant.NewQuery(vectors[0]...),
		Filter:         &qdrant.Filter{Must: []*qdrant.Condition{qdrant.NewMatchKeywords("hash", Hashes(tools)...)}},
		Limit:          &limit,
		WithPayload:    qdrant.NewWithPayload(true),
	})
	if err != nil {
		return nil, fmt.Errorf("query caller tools: %w", err)
	}

	// Resolve back to the REQUEST's own descriptors rather than trusting the
	// stored payload. Belt and braces on the filter above: a point that somehow
	// matched without being in this request cannot make it into the result.
	byHash := make(map[string]Descriptor, len(tools))
	for _, tool := range tools {
		byHash[tool.Hash] = tool
	}
	out := make([]Descriptor, 0, len(points))
	for _, p := range points {
		if tool, ok := byHash[p.GetPayload()["hash"].GetStringValue()]; ok {
			out = append(out, tool)
		}
	}
	return out, nil
}

// Prune reclaims abandoned definitions. Qdrant has no native TTL, so without
// this the collection grows forever — every definition any caller ever sent,
// including one-off experiments and every intermediate edit of a schema.
func (s *QdrantStore) Prune(ctx context.Context, olderThanSeconds int64) (int, error) {
	cutoff := float64(time.Now().Unix() - olderThanSeconds)
	stale := &qdrant.Filter{
		Must: []*qdrant.Condition{qdrant.NewRange("lastSeenAt", &qdrant.Range{Lt: &cutoff})},
	}

	// Counted before deleting: Delete reports an operation status, not how many
	// points it removed, and a prune that silently reclaims nothing looks
	// identical to one that reclaimed everything.
	count, err := s.client.Count(ctx, &qdrant.CountPoints{
		CollectionName: s.collection,
		Filter:         stale,
	})
	if err != nil {
		return 0, fmt.Errorf("count stale caller tools: %w", err)
	}
	if count == 0 {
		return 0, nil
	}

	wait := true
	if _, err := s.client.Delete(ctx, &qdrant.DeletePoints{
		CollectionName: s.collection,
		Points:         qdrant.NewPointsSelectorFilter(stale),
		Wait:           &wait,
	}); err != nil {
		return 0, fmt.Errorf("prune caller tools: %w", err)
	}
	return int(count), nil
}
