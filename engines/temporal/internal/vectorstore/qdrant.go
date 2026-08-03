package vectorstore

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"
	"github.com/qdrant/go-client/qdrant"
)

// Qdrant implements Store over one Qdrant collection. Nothing outside this
// file touches the Qdrant client (agent-controller ADR 0003's port rule).
type Qdrant struct {
	client     *qdrant.Client
	collection string
	embedder   Embedder
	dims       uint64
}

func NewQdrant(client *qdrant.Client, collection string, embedder Embedder, dims uint64) *Qdrant {
	return &Qdrant{client: client, collection: collection, embedder: embedder, dims: dims}
}

// EnsureCollection creates the collection if it doesn't exist (cosine
// distance, matching the embedding model's semantics).
func (s *Qdrant) EnsureCollection(ctx context.Context) error {
	exists, err := s.client.CollectionExists(ctx, s.collection)
	if err != nil {
		return fmt.Errorf("check collection %s: %w", s.collection, err)
	}
	if exists {
		return nil
	}
	err = s.client.CreateCollection(ctx, &qdrant.CreateCollection{
		CollectionName: s.collection,
		VectorsConfig: qdrant.NewVectorsConfig(&qdrant.VectorParams{
			Size:     s.dims,
			Distance: qdrant.Distance_Cosine,
		}),
	})
	if err != nil {
		return fmt.Errorf("create collection %s: %w", s.collection, err)
	}
	return nil
}

// pointID derives a stable UUID for a record id (Qdrant point ids must be
// UUIDs or integers; the real id lives in the payload).
func (s *Qdrant) pointID(id string) string {
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("github.com/controller-agent/temporal-engine/"+s.collection+"/"+id)).String()
}

func (s *Qdrant) Upsert(ctx context.Context, records []Record) error {
	if len(records) == 0 {
		return nil
	}
	texts := make([]string, len(records))
	for i, r := range records {
		texts[i] = r.Text
	}
	vectors, err := s.embedder.Embed(ctx, texts)
	if err != nil {
		return fmt.Errorf("embed %d records: %w", len(records), err)
	}

	points := make([]*qdrant.PointStruct, len(records))
	for i, r := range records {
		roles := make([]any, len(r.Roles))
		for j, role := range r.Roles {
			roles[j] = role
		}
		points[i] = &qdrant.PointStruct{
			Id:      qdrant.NewIDUUID(s.pointID(r.ID)),
			Vectors: qdrant.NewVectors(vectors[i]...),
			Payload: qdrant.NewValueMap(map[string]any{
				"id":           r.ID,
				"roles":        roles,
				"unrestricted": r.Unrestricted,
				"descriptor":   string(r.Descriptor),
			}),
		}
	}

	wait := true
	_, err = s.client.Upsert(ctx, &qdrant.UpsertPoints{
		CollectionName: s.collection,
		Points:         points,
		Wait:           &wait,
	})
	if err != nil {
		return fmt.Errorf("upsert %d points into %s: %w", len(points), s.collection, err)
	}
	return nil
}

func (s *Qdrant) Delete(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	pointIDs := make([]*qdrant.PointId, len(ids))
	for i, id := range ids {
		pointIDs[i] = qdrant.NewIDUUID(s.pointID(id))
	}
	wait := true
	_, err := s.client.Delete(ctx, &qdrant.DeletePoints{
		CollectionName: s.collection,
		Points:         qdrant.NewPointsSelector(pointIDs...),
		Wait:           &wait,
	})
	if err != nil {
		return fmt.Errorf("delete %d points from %s: %w", len(ids), s.collection, err)
	}
	return nil
}

// visibilityFilter admits records whose roles intersect the caller's, plus
// unrestricted records. With no caller roles only unrestricted records
// match — the fail-closed default.
func visibilityFilter(callerRoles []string) *qdrant.Filter {
	conditions := []*qdrant.Condition{qdrant.NewMatchBool("unrestricted", true)}
	if len(callerRoles) > 0 {
		conditions = append(conditions, qdrant.NewMatchKeywords("roles", callerRoles...))
	}
	return &qdrant.Filter{Should: conditions}
}

func (s *Qdrant) Query(ctx context.Context, text string, callerRoles []string, limit int) ([]Hit, error) {
	vectors, err := s.embedder.Embed(ctx, []string{text})
	if err != nil {
		return nil, fmt.Errorf("embed query: %w", err)
	}

	limit64 := uint64(limit)
	points, err := s.client.Query(ctx, &qdrant.QueryPoints{
		CollectionName: s.collection,
		Query:          qdrant.NewQuery(vectors[0]...),
		Filter:         visibilityFilter(callerRoles),
		Limit:          &limit64,
		WithPayload:    qdrant.NewWithPayload(true),
	})
	if err != nil {
		return nil, fmt.Errorf("query %s: %w", s.collection, err)
	}

	hits := make([]Hit, 0, len(points))
	for _, p := range points {
		hit, err := hitFromPayload(p.GetPayload())
		if err != nil {
			return nil, err
		}
		hit.Score = p.GetScore()
		hits = append(hits, hit)
	}
	return hits, nil
}

func (s *Qdrant) GetByIDs(ctx context.Context, ids []string, callerRoles []string) ([]Hit, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	pointIDs := make([]*qdrant.PointId, len(ids))
	for i, id := range ids {
		pointIDs[i] = qdrant.NewIDUUID(s.pointID(id))
	}
	points, err := s.client.Get(ctx, &qdrant.GetPoints{
		CollectionName: s.collection,
		Ids:            pointIDs,
		WithPayload:    qdrant.NewWithPayload(true),
	})
	if err != nil {
		return nil, fmt.Errorf("get %d points from %s: %w", len(ids), s.collection, err)
	}

	// Role re-check in code: direct lookups bypass the query filter, so this
	// is the defense-in-depth backstop (ADR 0008).
	callerSet := map[string]bool{}
	for _, r := range callerRoles {
		callerSet[r] = true
	}
	hits := make([]Hit, 0, len(points))
	for _, p := range points {
		payload := p.GetPayload()
		if !recordVisible(payload, callerSet) {
			continue
		}
		hit, err := hitFromPayload(payload)
		if err != nil {
			return nil, err
		}
		hits = append(hits, hit)
	}
	return hits, nil
}

// GetByIDsUnfiltered resolves records by id with no role check. See the Store
// interface for why this exists and the one question it may answer.
func (s *Qdrant) GetByIDsUnfiltered(ctx context.Context, ids []string) ([]Hit, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	pointIDs := make([]*qdrant.PointId, len(ids))
	for i, id := range ids {
		pointIDs[i] = qdrant.NewIDUUID(s.pointID(id))
	}
	points, err := s.client.Get(ctx, &qdrant.GetPoints{
		CollectionName: s.collection,
		Ids:            pointIDs,
		WithPayload:    qdrant.NewWithPayload(true),
	})
	if err != nil {
		return nil, fmt.Errorf("get %d points from %s: %w", len(ids), s.collection, err)
	}
	hits := make([]Hit, 0, len(points))
	for _, p := range points {
		hit, err := hitFromPayload(p.GetPayload())
		if err != nil {
			return nil, err
		}
		hits = append(hits, hit)
	}
	return hits, nil
}

func recordVisible(payload map[string]*qdrant.Value, callerRoles map[string]bool) bool {
	if payload["unrestricted"].GetBoolValue() {
		return true
	}
	for _, v := range payload["roles"].GetListValue().GetValues() {
		if callerRoles[v.GetStringValue()] {
			return true
		}
	}
	return false
}

func hitFromPayload(payload map[string]*qdrant.Value) (Hit, error) {
	id := payload["id"].GetStringValue()
	descriptor := payload["descriptor"].GetStringValue()
	if id == "" || descriptor == "" {
		return Hit{}, fmt.Errorf("point payload missing id/descriptor")
	}
	return Hit{ID: id, Descriptor: json.RawMessage(descriptor)}, nil
}
