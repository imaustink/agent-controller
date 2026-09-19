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
	token     string
	err       error
	askedFor  []string
	callCount int
}

func (f *fakeResolver) DelegatedToken(_ context.Context, _ activities.Caller, providers []string) (string, error) {
	f.callCount++
	f.askedFor = providers
	return f.token, f.err
}

func searchTool(members ...catalog.KnowledgeBaseExecMember) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID: "kb:snc/search",
		KnowledgeBaseExec: &catalog.KnowledgeBaseExecSpec{
			KnowledgeBaseID:           "snc",
			DisplayName:               "SNC",
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
			Tool:   catalog.ToolDescriptor{ID: "kb:snc/search"},
		})

	require.Error(t, err)
}

func TestSearchDoesNotSilentlyRunASearchForANonSearchOperation(t *testing.T) {
	resolver := &fakeResolver{token: "t"}
	tool := searchTool(member("c", []string{"reader"}, "coll"))
	tool.ID = "kb:snc/fetch"
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
