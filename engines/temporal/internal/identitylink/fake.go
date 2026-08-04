package identitylink

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"
)

// Fake is the cluster-less stand-in for the gateway: an in-memory credential
// store seeded from env JSON. It is what the dev-mode worker uses, and what
// the pre-flight's tests exercise, so the two agree on semantics.
//
// It implements every optional-in-spirit method for real, including Rekey,
// because the pre-flight's adoption path is one of the easiest things to get
// subtly wrong and a fake that no-ops it would hide that.
type Fake struct {
	mu sync.Mutex
	// tokens is provider -> subject -> token.
	tokens map[string]map[string]Token
	// urls is provider -> the link URL to hand a user.
	urls map[string]string

	// StartErr, when set for a provider, makes Start fail — the pre-flight's
	// degrade-not-block behaviour is only testable if a start can fail.
	StartErr map[string]error
	// LinkedLoginErr, when set, makes the identity lookup ERROR, which the
	// pre-flight must treat as "unknown", not as "no link".
	LinkedLoginErr map[string]error
	// CompleteOnWait makes Wait resolve as if the human finished linking.
	CompleteOnWait map[string]Token

	Started []StartedFlow
	Rekeyed []RekeyCall
}

type StartedFlow struct{ Provider, Subject, Flow string }

type RekeyCall struct{ Provider, From, To string }

// NewFake parses the dev env format:
//
//	IDENTITY_LINKS:     {"github": {"user:austin": {"token":"gho_x","githubLogin":"austin"}}}
//	IDENTITY_LINK_URLS: {"github": "https://github.com/login/device"}
func NewFake(linksJSON, urlsJSON string) (*Fake, error) {
	f := &Fake{
		tokens:         map[string]map[string]Token{},
		urls:           map[string]string{},
		StartErr:       map[string]error{},
		LinkedLoginErr: map[string]error{},
		CompleteOnWait: map[string]Token{},
	}
	if linksJSON != "" {
		if err := json.Unmarshal([]byte(linksJSON), &f.tokens); err != nil {
			return nil, fmt.Errorf("parse IDENTITY_LINKS: %w", err)
		}
	}
	if urlsJSON != "" {
		if err := json.Unmarshal([]byte(urlsJSON), &f.urls); err != nil {
			return nil, fmt.Errorf("parse IDENTITY_LINK_URLS: %w", err)
		}
	}
	return f, nil
}

// Set seeds a credential.
func (f *Fake) Set(provider, subject string, token Token) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.tokens[provider] == nil {
		f.tokens[provider] = map[string]Token{}
	}
	f.tokens[provider][subject] = token
}

func (f *Fake) Start(_ context.Context, provider, subject, flow string) (StartResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.StartErr[provider]; err != nil {
		return StartResult{}, err
	}
	f.Started = append(f.Started, StartedFlow{provider, subject, flow})

	linkURL := f.urls[provider]
	if linkURL == "" {
		linkURL = "https://example.invalid/link/" + provider
	}
	switch flow {
	case FlowDevice:
		return StartResult{
			Flow: FlowDevice, VerificationURI: linkURL, UserCode: "ABCD-1234",
			DeviceCode: "device-" + provider, ExpiresInSeconds: 900, PollIntervalSeconds: 5,
		}, nil
	default:
		if strings.HasPrefix(provider, "claude") {
			return StartResult{Flow: FlowPage, PageURL: linkURL, ExpiresInSeconds: 600}, nil
		}
		return StartResult{Flow: FlowAuthCode, AuthorizeURL: linkURL, ExpiresInSeconds: 900}, nil
	}
}

func (f *Fake) Token(_ context.Context, provider, subject string) (*Token, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	token, ok := f.tokens[provider][subject]
	if !ok || token.Value == "" {
		return nil, nil
	}
	return &token, nil
}

func (f *Fake) LinkedLogin(_ context.Context, provider, subject string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := f.LinkedLoginErr[provider]; err != nil {
		return "", err
	}
	return f.tokens[provider][subject].GitHubLogin, nil
}

func (f *Fake) Poll(_ context.Context, provider, subject, _ string) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, ok := f.tokens[provider][subject]; ok {
		return PollComplete, nil
	}
	return PollPending, nil
}

func (f *Fake) Wait(_ context.Context, provider, subject string, _ time.Duration) (*Token, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if token, ok := f.CompleteOnWait[provider]; ok {
		if f.tokens[provider] == nil {
			f.tokens[provider] = map[string]Token{}
		}
		f.tokens[provider][subject] = token
		delete(f.CompleteOnWait, provider)
		return &token, nil
	}
	if token, ok := f.tokens[provider][subject]; ok && token.Value != "" {
		return &token, nil
	}
	return nil, nil
}

func (f *Fake) Invalidate(_ context.Context, provider, subject string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.tokens[provider], subject)
	return nil
}

func (f *Fake) Rekey(_ context.Context, provider, from, to string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.Rekeyed = append(f.Rekeyed, RekeyCall{provider, from, to})

	token, ok := f.tokens[provider][from]
	if !ok || token.Value == "" {
		return false, nil
	}
	// Never overwrite the destination: a record already there is by definition
	// at least as current as the one being moved.
	if existing, ok := f.tokens[provider][to]; ok && existing.Value != "" {
		return false, nil
	}
	f.tokens[provider][to] = token
	delete(f.tokens[provider], from)
	return true, nil
}

func (f *Fake) WritebackGrant(_ context.Context, provider, subject string, _ time.Duration) (*WritebackGrant, error) {
	if provider != ProviderClaudeRemote {
		return nil, nil
	}
	return &WritebackGrant{
		URL:        "https://example.invalid/writeback/" + subject,
		Token:      "writeback-" + subject,
		SecretName: "writeback-" + strings.ReplaceAll(subject, ":", "-"),
	}, nil
}
