package activities_test

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

type fakeResolver struct {
	token      string
	principals []string
	err        error
	askedFor   []string
	callCount  int
}

func (f *fakeResolver) DelegatedToken(
	_ context.Context, _ activities.Caller, providers []string,
) (activities.DelegatedCredential, error) {
	f.callCount++
	f.askedFor = providers
	return activities.DelegatedCredential{Token: f.token, Principals: f.principals}, f.err
}

func (f *fakeResolver) DelegatedTokens(
	_ context.Context, _ activities.Caller, providers []string,
) (map[string]activities.DelegatedCredential, error) {
	f.callCount++
	f.askedFor = providers
	if f.err != nil {
		return nil, f.err
	}
	out := map[string]activities.DelegatedCredential{}
	// An empty token stands in for "nothing linked", so the map stays empty and
	// the activity asks for a link — matching the single-token stub's semantics.
	if f.token != "" {
		for _, provider := range providers {
			out[provider] = activities.DelegatedCredential{Token: f.token, Principals: f.principals}
		}
	}
	return out, nil
}

// perProviderResolver resolves tokens only for the providers it was told about,
// to exercise partial linking across a mixed knowledge base.
type perProviderResolver struct {
	linked map[string]string
	asked  [][]string
}

func (r *perProviderResolver) DelegatedToken(
	_ context.Context, _ activities.Caller, providers []string,
) (activities.DelegatedCredential, error) {
	r.asked = append(r.asked, providers)
	for _, provider := range providers {
		if token, ok := r.linked[provider]; ok {
			return activities.DelegatedCredential{Token: token}, nil
		}
	}
	return activities.DelegatedCredential{}, nil
}

func (r *perProviderResolver) DelegatedTokens(
	_ context.Context, _ activities.Caller, providers []string,
) (map[string]activities.DelegatedCredential, error) {
	r.asked = append(r.asked, providers)
	out := map[string]activities.DelegatedCredential{}
	for _, provider := range providers {
		if token, ok := r.linked[provider]; ok {
			out[provider] = activities.DelegatedCredential{Token: token}
		}
	}
	return out, nil
}

// recordingCorpora opens an empty store per collection and records which
// collections it was asked to open — the Go stand-in for the TS searcher's
// injected openCorpus factory.
type recordingCorpora struct{ opened []string }

func (c *recordingCorpora) Resolve(_ context.Context, collections []string) ([]vectorstore.Store, int, error) {
	c.opened = append(c.opened, collections...)
	stores := make([]vectorstore.Store, 0, len(collections))
	for range collections {
		stores = append(stores, newFakeStore())
	}
	return stores, 0, nil
}

func searchTool(members ...catalog.KnowledgeBaseExecMember) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID: "kb:globex/search",
		KnowledgeBaseExec: &catalog.KnowledgeBaseExecSpec{
			KnowledgeBaseID:           "globex",
			DisplayName:               "GLOBEX",
			Operation:                 "search",
			Members:                   members,
			DisclosePartialVisibility: true,
		},
	}
}

func member(id string, roles []string, collection string) catalog.KnowledgeBaseExecMember {
	return catalog.KnowledgeBaseExecMember{
		ID: id, Label: "#" + id, Collection: collection,
		AllowedRoles: roles, Granularity: "resource", IdentityProviders: []string{"atlassian"},
	}
}

func activitiesWith(resolver activities.DelegatedCredentialResolver) *activities.KnowledgeBaseActivities {
	return &activities.KnowledgeBaseActivities{
		// Corpora is only reached once a member is visible AND a token
		// resolved; the specs below that get that far supply their own.
		Corpora:     vectorstore.NewCorpora(nil, nil, 0),
		Credentials: resolver,
		BrokerURL:   "http://broker",
		BrokerToken: "orch",
	}
}

func TestSearchFailsClosedWithoutAResolvedIdentity(t *testing.T) {
	out, err := activitiesWith(&fakeResolver{token: "t"}).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Tool:  searchTool(member("c", []string{"reader"}, "coll")),
			Query: "q",
		})

	require.NoError(t, err)
	require.Contains(t, out.Result, "could not establish who is asking")
	require.False(t, out.NeedsLink)
}

func TestSearchRejectsAToolWithNoExecutionSpec(t *testing.T) {
	_, err := activitiesWith(&fakeResolver{}).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   catalog.ToolDescriptor{ID: "kb:globex/search"},
		})

	require.Error(t, err)
}

func TestSearchDoesNotSilentlyRunASearchForANonSearchOperation(t *testing.T) {
	resolver := &fakeResolver{token: "t"}
	tool := searchTool(member("c", []string{"reader"}, "coll"))
	tool.ID = "kb:globex/fetch"
	tool.KnowledgeBaseExec.Operation = "fetch"

	out, err := activitiesWith(resolver).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Query:  "some-source-id",
			Tool:   tool,
		})

	// A fetch would need a whole-document source read that is deferred; it must
	// fail closed, never degrade into a similarity search over the source id.
	require.NoError(t, err)
	require.Contains(t, out.Result, "only search is supported")
	require.NotContains(t, out.Result, "Sources:")
	require.Zero(t, resolver.callCount, "no credential should be resolved for an unsupported operation")
}

func TestSearchDisclosesWithheldSourcesWithoutQueryingAnything(t *testing.T) {
	resolver := &fakeResolver{token: "t"}

	out, err := activitiesWith(resolver).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			// Only a lead may read this member.
			Tool:  searchTool(member("leads", []string{"lead"}, "coll")),
			Query: "q",
		})

	require.NoError(t, err)
	require.Contains(t, out.Result, "No passages")
	require.Contains(t, out.Result, "outside your access")
	// Nothing to search, so no credential was needed and none was requested.
	require.Zero(t, resolver.callCount)
}

func TestSearchCountsAnUnreconciledMemberAsWithheld(t *testing.T) {
	out, err := activitiesWith(&fakeResolver{token: "t"}).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			// Readable, but nothing indexed yet.
			Tool:  searchTool(member("fresh", []string{"reader"}, "")),
			Query: "q",
		})

	require.NoError(t, err)
	// Still something the answer is missing, so it is disclosed rather than
	// silently treated as an empty corpus.
	require.Contains(t, out.Result, "outside your access")
}

func TestSearchAsksForALinkRatherThanAnsweringUnchecked(t *testing.T) {
	out, err := activitiesWith(&fakeResolver{token: ""}).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   searchTool(member("c", []string{"reader"}, "coll")),
			Query:  "q",
		})

	require.NoError(t, err)
	require.True(t, out.NeedsLink)
	require.Contains(t, out.Result, "link the account")
	// Probing on the ingestion credential would answer a different question,
	// permissively — so there is no partial answer to fall back on.
	require.NotContains(t, out.Result, "Sources:")
}

func TestSearchAsksForTheUnionOfItsVisibleMembersProviders(t *testing.T) {
	resolver := &fakeResolver{token: ""}
	drive := member("drive", []string{"reader"}, "coll-2")
	drive.IdentityProviders = []string{"google"}

	_, err := activitiesWith(resolver).SearchKnowledgeBase(context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   searchTool(member("conf", []string{"reader"}, "coll-1"), drive),
			Query:  "q",
		})

	require.NoError(t, err)
	// Sorted, so the resolver sees a stable request.
	require.Equal(t, []string{"atlassian", "google"}, resolver.askedFor)
}

func TestSearchSurfacesACredentialResolutionFailure(t *testing.T) {
	_, err := activitiesWith(&fakeResolver{err: errors.New("secret store down")}).SearchKnowledgeBase(
		context.Background(),
		activities.SearchKnowledgeBaseInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   searchTool(member("c", []string{"reader"}, "coll")),
			Query:  "q",
		})

	// Not swallowed into an empty answer: a credential we could not resolve is
	// different from one the caller does not have.
	require.Error(t, err)
}

func TestSearchServesTheLinkedProvidersOfAMixedBaseAndNamesTheOneToLink(t *testing.T) {
	corpora := &recordingCorpora{}
	drive := member("drive", []string{"reader"}, "coll-drive")
	drive.IdentityProviders = []string{"google"}

	out, err := (&activities.KnowledgeBaseActivities{
		Corpora:     corpora,
		Credentials: &perProviderResolver{linked: map[string]string{"atlassian": "at"}},
		BrokerURL:   "http://broker",
		BrokerToken: "orch",
	}).SearchKnowledgeBase(context.Background(), activities.SearchKnowledgeBaseInput{
		Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
		Tool:   searchTool(member("conf", []string{"reader"}, "coll-conf"), drive),
		Query:  "q",
	})

	require.NoError(t, err)
	// Confluence is linked, so it is searched; Drive is not, so it becomes an
	// honest "link google to see more" rather than a silent drop.
	require.Equal(t, []string{"coll-conf"}, corpora.opened)
	require.False(t, out.NeedsLink)
	require.Contains(t, out.Result, "have not linked (google)")
}

func TestSearchSearchesEveryMemberWhenAllProvidersAreLinked(t *testing.T) {
	corpora := &recordingCorpora{}
	drive := member("drive", []string{"reader"}, "coll-drive")
	drive.IdentityProviders = []string{"google"}
	channel := member("chan", []string{"reader"}, "coll-chan")
	channel.IdentityProviders = []string{"slack"}
	channel.Granularity = "connection"

	out, err := (&activities.KnowledgeBaseActivities{
		Corpora:     corpora,
		Credentials: &perProviderResolver{linked: map[string]string{"atlassian": "at", "google": "g", "slack": "s"}},
		BrokerURL:   "http://broker",
		BrokerToken: "orch",
	}).SearchKnowledgeBase(context.Background(), activities.SearchKnowledgeBaseInput{
		Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
		Tool:   searchTool(member("conf", []string{"reader"}, "coll-conf"), drive, channel),
		Query:  "q",
	})

	require.NoError(t, err)
	require.ElementsMatch(t, []string{"coll-conf", "coll-drive", "coll-chan"}, corpora.opened)
	// Nothing left unlinked, so no "link this to see more" caveat.
	require.NotContains(t, out.Result, "have not linked")
}

func TestSearchAsksNamingAllProvidersWhenTheCallerHasLinkedNone(t *testing.T) {
	corpora := &recordingCorpora{}
	drive := member("drive", []string{"reader"}, "coll-drive")
	drive.IdentityProviders = []string{"google"}

	out, err := (&activities.KnowledgeBaseActivities{
		Corpora:     corpora,
		Credentials: &perProviderResolver{linked: map[string]string{}},
		BrokerURL:   "http://broker",
		BrokerToken: "orch",
	}).SearchKnowledgeBase(context.Background(), activities.SearchKnowledgeBaseInput{
		Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
		Tool:   searchTool(member("conf", []string{"reader"}, "coll-conf"), drive),
		Query:  "q",
	})

	require.NoError(t, err)
	require.True(t, out.NeedsLink)
	require.Contains(t, out.Result, "atlassian, google")
	// Nothing could be probed, so nothing was opened.
	require.Empty(t, corpora.opened)
}
