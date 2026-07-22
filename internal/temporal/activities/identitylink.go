package activities

import (
	"context"
	"encoding/json"
	"fmt"
)

const GetIdentityLinkActivityName = "GetIdentityLink"

// IdentityLinkStore is the port over per-user provider credentials
// (agent-controller ADR 0022's identity-link gateway). The static impl is
// dev-grade; a real OAuth device-flow broker is the production follow-up.
type IdentityLinkStore interface {
	// Token returns the caller's linked credential for a provider, if any.
	Token(subject, provider string) (string, bool)
	// LinkURL is where the user goes to link the provider.
	LinkURL(provider string) string
}

type IdentityLinkInput struct {
	Caller    Caller   `json:"caller"`
	Providers []string `json:"providers"`
}

type IdentityLinkStatus struct {
	Linked bool `json:"linked"`
	// When not linked: which provider is missing and where to link it.
	MissingProvider string `json:"missingProvider,omitempty"`
	LinkURL         string `json:"linkUrl,omitempty"`
}

type IdentityLinkActivities struct {
	Store IdentityLinkStore
}

// GetIdentityLink reports whether the caller has linked every required
// provider. It never returns tokens to the workflow — checking is the
// workflow's business; injection into Jobs is the launcher's (pending the
// upstream ToolRunSpec.secretEnv addition).
func (a *IdentityLinkActivities) GetIdentityLink(ctx context.Context, in IdentityLinkInput) (IdentityLinkStatus, error) {
	if in.Caller.Subject == "" {
		if len(in.Providers) == 0 {
			return IdentityLinkStatus{Linked: true}, nil
		}
		return IdentityLinkStatus{MissingProvider: in.Providers[0], LinkURL: a.Store.LinkURL(in.Providers[0])}, nil
	}
	for _, provider := range in.Providers {
		if _, ok := a.Store.Token(in.Caller.Subject, provider); !ok {
			return IdentityLinkStatus{
				MissingProvider: provider,
				LinkURL:         a.Store.LinkURL(provider),
			}, nil
		}
	}
	return IdentityLinkStatus{Linked: true}, nil
}

// StaticIdentityLinks reads IDENTITY_LINKS-style JSON:
//
//	{"user:austin": {"github": "gho_xxx"}}
//
// and IDENTITY_LINK_URLS: {"github": "https://github.com/login/device"}.
type StaticIdentityLinks struct {
	links map[string]map[string]string
	urls  map[string]string
}

func NewStaticIdentityLinks(linksJSON, urlsJSON string) (*StaticIdentityLinks, error) {
	s := &StaticIdentityLinks{
		links: map[string]map[string]string{},
		urls:  map[string]string{},
	}
	if linksJSON != "" {
		if err := json.Unmarshal([]byte(linksJSON), &s.links); err != nil {
			return nil, fmt.Errorf("parse identity links: %w", err)
		}
	}
	if urlsJSON != "" {
		if err := json.Unmarshal([]byte(urlsJSON), &s.urls); err != nil {
			return nil, fmt.Errorf("parse identity link urls: %w", err)
		}
	}
	return s, nil
}

func (s *StaticIdentityLinks) Token(subject, provider string) (string, bool) {
	token, ok := s.links[subject][provider]
	return token, ok && token != ""
}

func (s *StaticIdentityLinks) LinkURL(provider string) string {
	if url := s.urls[provider]; url != "" {
		return url
	}
	return "(no link URL configured for " + provider + ")"
}
