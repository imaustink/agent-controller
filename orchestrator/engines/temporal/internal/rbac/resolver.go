// Package rbac resolves caller identity. RBAC fails closed everywhere: an
// unresolved identity gets no subject, and no subject means the retrieval
// activities return nothing.
package rbac

import (
	"encoding/json"
	"fmt"
)

type Identity struct {
	Subject string   `json:"subject"`
	Roles   []string `json:"roles,omitempty"`
}

// Resolver maps a bearer token to an identity. A nil return means
// "unresolved" — never an error to the caller, just no capabilities.
type Resolver interface {
	Resolve(token string) *Identity
}

// StaticResolver is the dev/test resolver (upstream's default): a fixed
// token→identity map, optionally with a fallback identity for tokenless or
// unknown callers. An OIDC resolver is the production follow-up.
type StaticResolver struct {
	identities map[string]Identity
	fallback   *Identity
}

// NewStaticResolver parses STATIC_IDENTITIES-style JSON:
//
//	{"token-abc": {"subject": "user:austin", "roles": ["cook", "admin"]}}
func NewStaticResolver(identitiesJSON string, fallback *Identity) (*StaticResolver, error) {
	identities := map[string]Identity{}
	if identitiesJSON != "" {
		if err := json.Unmarshal([]byte(identitiesJSON), &identities); err != nil {
			return nil, fmt.Errorf("parse static identities: %w", err)
		}
		for token, id := range identities {
			if id.Subject == "" {
				return nil, fmt.Errorf("static identity for token %q missing subject", token)
			}
		}
	}
	return &StaticResolver{identities: identities, fallback: fallback}, nil
}

func (r *StaticResolver) Resolve(token string) *Identity {
	if id, ok := r.identities[token]; ok {
		return &id
	}
	return r.fallback
}
