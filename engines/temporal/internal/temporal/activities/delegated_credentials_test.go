package activities_test

import (
	"context"
	"errors"
	"testing"

	"github.com/controller-agent/temporal-engine/internal/identitylink"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

type stubLinks struct {
	identitylink.Port
	tokens     map[string]identitylink.Token
	accountIDs map[string]string
	logins     map[string]string
	tokenErr   error
	idErr      error
	asked      []string
}

func (s *stubLinks) Token(_ context.Context, provider, subject string) (*identitylink.Token, error) {
	s.asked = append(s.asked, provider+"/"+subject)
	if s.tokenErr != nil {
		return nil, s.tokenErr
	}
	token, ok := s.tokens[provider+"/"+subject]
	if !ok {
		return nil, nil
	}
	return &token, nil
}

func (s *stubLinks) LinkedAccountID(_ context.Context, provider, subject string) (string, error) {
	if s.idErr != nil {
		return "", s.idErr
	}
	return s.accountIDs[provider+"/"+subject], nil
}

func (s *stubLinks) LinkedLogin(_ context.Context, provider, subject string) (string, error) {
	return s.logins[provider+"/"+subject], nil
}

func TestResolvesTheCallersOwnCredential(t *testing.T) {
	links := &stubLinks{
		tokens:     map[string]identitylink.Token{"atlassian/openwebui:42": {Value: "at-1"}},
		accountIDs: map[string]string{"atlassian/openwebui:42": "557058:abc"},
	}
	resolver := &activities.LinkedCredentials{Links: links}

	got, err := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "openwebui:42"}, []string{"atlassian"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Token != "at-1" {
		t.Fatalf("token = %q", got.Token)
	}
	if len(got.Principals) != 1 || got.Principals[0] != "user:557058:abc" {
		t.Fatalf("principals = %v", got.Principals)
	}
}

func TestKeysOnTheRawSubjectForAnOrdinaryProvider(t *testing.T) {
	links := &stubLinks{tokens: map[string]identitylink.Token{"atlassian/openwebui:42": {Value: "t"}}}
	resolver := &activities.LinkedCredentials{Links: links}

	// A resolver looking under a different key than the linker wrote to finds
	// nothing and asks the caller to re-link forever.
	_, err := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "openwebui:42", Principal: "github:someone"}, []string{"atlassian"})
	if err != nil {
		t.Fatal(err)
	}
	if len(links.asked) != 1 || links.asked[0] != "atlassian/openwebui:42" {
		t.Fatalf("looked under %v, expected the raw subject", links.asked)
	}
}

func TestEmptyWhenNothingIsLinked(t *testing.T) {
	resolver := &activities.LinkedCredentials{Links: &stubLinks{}}

	got, err := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "s"}, []string{"atlassian"})
	// Empty rather than an error: the activity turns this into an ask, which is
	// the honest response when a caller genuinely has not linked.
	if err != nil || got.Token != "" {
		t.Fatalf("got %+v err %v", got, err)
	}
}

func TestALookupFAILUREIsNotReportedAsNoLink(t *testing.T) {
	resolver := &activities.LinkedCredentials{Links: &stubLinks{tokenErr: errors.New("gateway down")}}

	_, err := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "s"}, []string{"atlassian"})

	// Swallowing this tells a caller to link an account they already linked, on
	// every turn, while the same record works moments later (ADR 0031).
	if err == nil {
		t.Fatal("a failed lookup must not read as an absent link")
	}
}

func TestTriesProvidersInTheOrderGiven(t *testing.T) {
	links := &stubLinks{tokens: map[string]identitylink.Token{"slack/s": {Value: "slack-token"}}}
	resolver := &activities.LinkedCredentials{Links: links}

	got, err := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "s"}, []string{"atlassian", "slack"})
	if err != nil {
		t.Fatal(err)
	}
	if got.Token != "slack-token" {
		t.Fatalf("token = %q", got.Token)
	}
	if len(links.asked) != 2 || links.asked[0] != "atlassian/s" {
		t.Fatalf("asked %v, expected the declared order", links.asked)
	}
}

func TestStillReturnsTheTokenWhenPrincipalsCannotBeResolved(t *testing.T) {
	links := &stubLinks{
		tokens: map[string]identitylink.Token{"atlassian/s": {Value: "at"}},
		idErr:  errors.New("identity endpoint down"),
	}
	resolver := &activities.LinkedCredentials{Links: links}

	got, err := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "s"}, []string{"atlassian"})
	if err != nil {
		t.Fatal(err)
	}
	// Principals feed a pre-filter that can only save probes. Failing the whole
	// search because they were unavailable would trade a working retrieval for
	// an optimization.
	if got.Token != "at" || got.Principals != nil {
		t.Fatalf("got %+v", got)
	}
}

func TestFallsBackToALoginForGitHubShapedLinks(t *testing.T) {
	links := &stubLinks{
		tokens: map[string]identitylink.Token{"github/s": {Value: "gh"}},
		logins: map[string]string{"github/s": "octocat"},
	}
	resolver := &activities.LinkedCredentials{Links: links}

	got, _ := resolver.DelegatedToken(context.Background(),
		activities.Caller{Subject: "s"}, []string{"github"})
	if len(got.Principals) != 1 || got.Principals[0] != "user:octocat" {
		t.Fatalf("principals = %v", got.Principals)
	}
}
