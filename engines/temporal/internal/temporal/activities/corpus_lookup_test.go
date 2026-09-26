package activities_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

func lookupTool(members ...catalog.KnowledgeBaseExecMember) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID: "kb:globex/lookup",
		KnowledgeBaseExec: &catalog.KnowledgeBaseExecSpec{
			KnowledgeBaseID: "globex",
			DisplayName:     "GLOBEX",
			Operation:       "lookup",
			Members:         members,
		},
	}
}

// brokerStub answers /corpora/<name>/search per corpus name.
func brokerStub(t *testing.T, byCorpus map[string]any) (*httptest.Server, *[]string) {
	t.Helper()
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path+"?"+r.URL.RawQuery)
		require.Equal(t, "user-token", r.Header.Get("x-delegated-token"),
			"the caller's own token, never the ingestion credential")

		for name, body := range byCorpus {
			if r.URL.Path == "/corpora/"+name+"/search" {
				if status, ok := body.(int); ok {
					w.WriteHeader(status)
					return
				}
				w.Header().Set("content-type", "application/json")
				require.NoError(t, json.NewEncoder(w).Encode(body))
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(srv.Close)
	return srv, &asked
}

func lookupActivities(srv *httptest.Server, resolver activities.DelegatedCredentialResolver) *activities.KnowledgeBaseActivities {
	return &activities.KnowledgeBaseActivities{
		Corpora:     vectorstore.NewCorpora(nil, nil, 0),
		Credentials: resolver,
		BrokerURL:   srv.URL,
		BrokerToken: "orch",
	}
}

func hits(items ...map[string]string) map[string]any {
	out := make([]map[string]string, 0, len(items))
	out = append(out, items...)
	return map[string]any{"hits": out}
}

func TestLookupFansOutAcrossMembersAndCitesReadableReferences(t *testing.T) {
	srv, asked := brokerStub(t, map[string]any{
		"wiki":  hits(map[string]string{"id": "123", "title": "Runbook", "url": "https://wiki/123", "excerpt": "deploy"}),
		"slack": hits(map[string]string{"id": "C1/1.1", "title": "thread", "url": "https://slack/1"}),
	})

	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool: lookupTool(
				member("wiki", []string{"reader"}, "c1"),
				member("slack", []string{"reader"}, "c2"),
			),
			Query: "deploy runbook",
		})

	require.NoError(t, err)
	require.Len(t, *asked, 2, "a knowledge base is a composition; the question goes to all of it")

	// The reference is what the READ tool takes. That pairing is the point:
	// a lookup finds the current document and hands back something readable.
	require.Contains(t, out.Result, "reference: wiki/123")
	require.Contains(t, out.Result, "reference: slack/C1/1.1")
	require.Contains(t, out.Result, "Runbook")
}

func TestLookupSkipsMembersTheCallerHoldsNoRoleFor(t *testing.T) {
	srv, asked := brokerStub(t, map[string]any{
		"wiki": hits(map[string]string{"id": "1", "title": "ok", "url": "u"}),
	})

	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool: lookupTool(
				member("wiki", []string{"reader"}, "c1"),
				member("execs", []string{"lead"}, "c2"),
			),
			Query: "salary",
		})

	require.NoError(t, err)
	// Union to invoke, per member to search: our policy layer, which is not
	// the same question as the source's.
	require.Len(t, *asked, 1)
	require.Contains(t, (*asked)[0], "/corpora/wiki/search")
	require.NotContains(t, out.Result, "execs")
}

func TestLookupReportsWhatItCouldNotSearchRatherThanLookingComplete(t *testing.T) {
	srv, _ := brokerStub(t, map[string]any{
		"wiki":  hits(map[string]string{"id": "1", "title": "Found", "url": "u"}),
		"slack": http.StatusNotFound, // no live search for this provider
		"drive": http.StatusForbidden,
	})

	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool: lookupTool(
				member("wiki", []string{"reader"}, "c1"),
				member("slack", []string{"reader"}, "c2"),
				member("drive", []string{"reader"}, "c3"),
			),
			Query: "q",
		})

	require.NoError(t, err)
	require.Contains(t, out.Result, "Found", "the members that answered still answer")
	// A partial answer the caller believes is complete is worse than one that
	// says what it could not reach.
	require.Contains(t, out.Result, "Could not search")
	require.Contains(t, out.Result, "no live search")
}

func TestLookupAsksForALinkOnlyWhenNothingCouldBeSearched(t *testing.T) {
	srv, _ := brokerStub(t, map[string]any{})

	out, err := lookupActivities(srv, &fakeResolver{token: ""}).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   lookupTool(member("wiki", []string{"reader"}, "c1")),
			Query:  "q",
		})

	require.NoError(t, err)
	require.True(t, out.NeedsLink)
	require.Contains(t, out.Result, "link the account")
}

func TestLookupDoesNotInterruptATurnThatPartlySucceeded(t *testing.T) {
	// One member answered, so asking for a link would interrupt a turn that
	// worked. The gap is reported in the prose instead.
	srv, _ := brokerStub(t, map[string]any{
		"wiki": hits(map[string]string{"id": "1", "title": "Found", "url": "u"}),
	})

	resolver := &perMemberResolver{tokens: map[string]string{"atlassian": "user-token"}}
	out, err := lookupActivities(srv, resolver).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool: lookupTool(
				member("wiki", []string{"reader"}, "c1"),
				linkless("drive", []string{"reader"}),
			),
			Query: "q",
		})

	require.NoError(t, err)
	require.False(t, out.NeedsLink)
	require.Contains(t, out.Result, "Found")
	require.Contains(t, out.Result, "Not searched (no linked account)")
}

func TestLookupRejectsAToolThatIsNotALookup(t *testing.T) {
	srv, _ := brokerStub(t, map[string]any{})

	_, err := lookupActivities(srv, &fakeResolver{token: "t"}).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   searchTool(member("wiki", []string{"reader"}, "c1")),
			Query:  "q",
		})

	require.Error(t, err)
}

func TestLookupRefusesAnEmptyQueryRatherThanSearchingForNothing(t *testing.T) {
	srv, asked := brokerStub(t, map[string]any{})

	out, err := lookupActivities(srv, &fakeResolver{token: "t"}).LookupCorpus(
		context.Background(),
		activities.LookupCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   lookupTool(member("wiki", []string{"reader"}, "c1")),
			Query:  "   ",
		})

	require.NoError(t, err)
	require.Empty(t, *asked)
	require.Contains(t, out.Result, "something to look for")
}

// linkless is a member whose identity provider nobody has linked.
func linkless(id string, roles []string) catalog.KnowledgeBaseExecMember {
	m := member(id, roles, "coll")
	m.IdentityProviders = []string{"google"}
	return m
}

// perMemberResolver returns a token only for the providers it knows.
type perMemberResolver struct{ tokens map[string]string }

func (r *perMemberResolver) DelegatedToken(
	_ context.Context, _ activities.Caller, providers []string,
) (activities.DelegatedCredential, error) {
	for _, provider := range providers {
		if token, ok := r.tokens[provider]; ok {
			return activities.DelegatedCredential{Token: token}, nil
		}
	}
	return activities.DelegatedCredential{}, nil
}
