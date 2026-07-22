// Package vectorstore is the retrieval port over the catalog collections
// (tools / skills / agents), with RBAC baked into every read: queries are
// role-filtered at the store (an unauthorized record is never a candidate),
// and lookups by id re-check roles as defense in depth — mirroring
// agent-controller ADRs 0003/0004/0008.
package vectorstore

import (
	"context"
	"encoding/json"
)

// Embedder is satisfied by *llm.Embedder.
type Embedder interface {
	Embed(ctx context.Context, inputs []string) ([][]float32, error)
}

// Record is one indexed catalog entry.
type Record struct {
	ID   string
	Text string // what gets embedded

	// Roles gates retrieval (match-any against the caller's roles).
	// Unrestricted marks records visible to any resolved identity (derived
	// tool-less skills); Roles is ignored when set.
	Roles        []string
	Unrestricted bool

	// Descriptor is the full descriptor JSON, returned verbatim on hits.
	Descriptor json.RawMessage
}

type Hit struct {
	ID         string
	Score      float32
	Descriptor json.RawMessage
}

type Store interface {
	Upsert(ctx context.Context, records []Record) error
	Delete(ctx context.Context, ids []string) error

	// Query returns the top-k role-visible records for the request text.
	// Empty callerRoles matches only Unrestricted records (fail closed).
	Query(ctx context.Context, text string, callerRoles []string, limit int) ([]Hit, error)

	// GetByIDs resolves records directly (no ranking), re-applying the same
	// role visibility check. Missing ids are silently absent from the result.
	GetByIDs(ctx context.Context, ids []string, callerRoles []string) ([]Hit, error)
}
