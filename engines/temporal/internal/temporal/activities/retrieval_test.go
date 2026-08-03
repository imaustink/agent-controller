package activities_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/catalog"
	"durable-agents/internal/temporal/activities"
	"durable-agents/internal/vectorstore"
)

// fakeStore serves canned records with the same visibility semantics as the
// Qdrant adapter (roles match-any OR unrestricted).
type fakeStore struct {
	records map[string]vectorstore.Record
}

func (f *fakeStore) Upsert(context.Context, []vectorstore.Record) error { return nil }
func (f *fakeStore) Delete(context.Context, []string) error             { return nil }

func (f *fakeStore) visible(r vectorstore.Record, roles []string) bool {
	if r.Unrestricted {
		return true
	}
	for _, want := range roles {
		for _, have := range r.Roles {
			if want == have {
				return true
			}
		}
	}
	return false
}

func (f *fakeStore) Query(_ context.Context, _ string, roles []string, limit int) ([]vectorstore.Hit, error) {
	var hits []vectorstore.Hit
	for _, r := range f.records {
		if f.visible(r, roles) && len(hits) < limit {
			hits = append(hits, vectorstore.Hit{ID: r.ID, Descriptor: r.Descriptor})
		}
	}
	return hits, nil
}

func (f *fakeStore) GetByIDs(_ context.Context, ids []string, roles []string) ([]vectorstore.Hit, error) {
	var hits []vectorstore.Hit
	for _, id := range ids {
		if r, ok := f.records[id]; ok && f.visible(r, roles) {
			hits = append(hits, vectorstore.Hit{ID: r.ID, Descriptor: r.Descriptor})
		}
	}
	return hits, nil
}

// GetByIDsUnfiltered deliberately ignores roles — see the Store interface for
// the one question it answers.
func (f *fakeStore) GetByIDsUnfiltered(_ context.Context, ids []string) ([]vectorstore.Hit, error) {
	var hits []vectorstore.Hit
	for _, id := range ids {
		if r, ok := f.records[id]; ok {
			hits = append(hits, vectorstore.Hit{ID: r.ID, Descriptor: r.Descriptor})
		}
	}
	return hits, nil
}

// newFakeStore builds a store from records, keyed by id.
func newFakeStore(records ...vectorstore.Record) *fakeStore {
	byID := make(map[string]vectorstore.Record, len(records))
	for _, r := range records {
		byID[r.ID] = r
	}
	return &fakeStore{records: byID}
}

func rec(id string, roles []string, unrestricted bool, descriptor any) vectorstore.Record {
	raw, _ := json.Marshal(descriptor)
	return vectorstore.Record{ID: id, Roles: roles, Unrestricted: unrestricted, Descriptor: raw}
}

func testActivities() *activities.RetrievalActivities {
	return &activities.RetrievalActivities{Collections: vectorstore.Collections{
		Skills: &fakeStore{records: map[string]vectorstore.Record{
			"recipes": rec("recipes", []string{"cook"}, false, map[string]any{
				"id": "recipes", "markdown": "# recipes", "toolIds": []string{"scraper", "deployer"},
			}),
			"chitchat": rec("chitchat", nil, true, map[string]any{"id": "chitchat"}),
		}},
		Tools: &fakeStore{records: map[string]vectorstore.Record{
			"scraper":  rec("scraper", []string{"cook"}, false, map[string]any{"id": "scraper"}),
			"deployer": rec("deployer", []string{"admin"}, false, map[string]any{"id": "deployer"}),
		}},
		Agents: &fakeStore{records: map[string]vectorstore.Record{}},
	}}
}

func TestRetrieveSkillsFailsClosedWithoutSubject(t *testing.T) {
	skills, err := testActivities().RetrieveSkills(context.Background(), activities.RetrieveInput{
		Caller:  activities.Caller{Subject: "", Roles: []string{"cook"}},
		Request: "scrape a recipe",
	})
	require.NoError(t, err)
	require.Empty(t, skills)
}

func TestRetrieveSkillsFiltersByRole(t *testing.T) {
	skills, err := testActivities().RetrieveSkills(context.Background(), activities.RetrieveInput{
		Caller:  activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
		Request: "scrape a recipe",
	})
	require.NoError(t, err)
	ids := make([]string, len(skills))
	for i, s := range skills {
		ids[i] = s.ID
	}
	require.ElementsMatch(t, []string{"recipes", "chitchat"}, ids)
}

func TestResolveSkillToolsDropsInvisibleRefs(t *testing.T) {
	result, err := testActivities().ResolveSkillTools(context.Background(), activities.ResolveSkillToolsInput{
		Caller:  activities.Caller{Subject: "user:1", Roles: []string{"cook"}},
		SkillID: "recipes",
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "recipes", result.Skill.ID)
	// deployer requires admin — resolved list only carries what the caller may use
	require.Len(t, result.Tools, 1)
	require.Equal(t, "scraper", result.Tools[0].ID)
}

func TestResolveSkillToolsInvisibleSkillIsNil(t *testing.T) {
	result, err := testActivities().ResolveSkillTools(context.Background(), activities.ResolveSkillToolsInput{
		Caller:  activities.Caller{Subject: "user:1", Roles: []string{"viewer"}},
		SkillID: "recipes",
	})
	require.NoError(t, err)
	require.Nil(t, result)
}

// --- an agent's own declared toolRefs (ADR 0028) ---

// The question is what the OPERATOR declared, not what the walk-in caller may
// reach. Routing it through the role-filtered read would make an agent's
// callable set depend on whoever's turn happened to launch it.
func TestResolveAgentToolsIgnoresCallerRoles(t *testing.T) {
	store := newFakeStore(
		rec("kubectl-readonly", []string{"sre"}, false, catalog.ToolDescriptor{ID: "kubectl-readonly", AllowedRoles: []string{"sre"}}),
		rec("signoz-query", []string{"sre"}, false, catalog.ToolDescriptor{ID: "signoz-query", AllowedRoles: []string{"sre"}}),
	)
	a := &activities.RetrievalActivities{Collections: vectorstore.Collections{Tools: store}}

	// The caller holds no roles at all, and would see neither tool through any
	// other read in this package.
	visible, err := a.RetrieveTools(context.Background(), activities.RetrieveInput{
		Caller: activities.Caller{Subject: "user:1"}, Request: "debug the cluster",
	})
	require.NoError(t, err)
	require.Empty(t, visible, "role-filtered retrieval sees nothing, as it should")

	declared, err := a.ResolveAgentTools(context.Background(), activities.ResolveAgentToolsInput{
		AgentID: "cluster-debug", ToolRefs: []string{"kubectl-readonly", "signoz-query"},
	})
	require.NoError(t, err)
	require.Len(t, declared, 2, "the operator's declaration stands regardless of the caller's roles")
}

// v1 scope cut, matching upstream: chaining sub-agent -> tool -> agent-backed
// tool -> another sub-agent raises depth, cost and cycle questions this feature
// does not need to answer.
func TestResolveAgentToolsDropsAgentBackedTools(t *testing.T) {
	store := newFakeStore(
		rec("plain", nil, true, catalog.ToolDescriptor{ID: "plain"}),
		rec("wrapped", nil, true, catalog.ToolDescriptor{ID: "wrapped", AgentRef: "some-agent"}),
	)
	a := &activities.RetrievalActivities{Collections: vectorstore.Collections{Tools: store}}

	declared, err := a.ResolveAgentTools(context.Background(), activities.ResolveAgentToolsInput{
		AgentID: "x", ToolRefs: []string{"plain", "wrapped"},
	})
	require.NoError(t, err)
	require.Len(t, declared, 1)
	require.Equal(t, "plain", declared[0].ID)
}

// A ref naming nothing is simply absent — an agent with a stale ref keeps
// working with a narrower toolset rather than failing to start.
func TestResolveAgentToolsSkipsMissingRefs(t *testing.T) {
	store := newFakeStore(rec("real", nil, true, catalog.ToolDescriptor{ID: "real"}))
	a := &activities.RetrievalActivities{Collections: vectorstore.Collections{Tools: store}}

	declared, err := a.ResolveAgentTools(context.Background(), activities.ResolveAgentToolsInput{
		AgentID: "x", ToolRefs: []string{"real", "deleted-last-week"},
	})
	require.NoError(t, err)
	require.Len(t, declared, 1)
	require.Equal(t, "real", declared[0].ID)
}

func TestResolveAgentToolsNoRefs(t *testing.T) {
	a := &activities.RetrievalActivities{Collections: vectorstore.Collections{Tools: newFakeStore()}}
	declared, err := a.ResolveAgentTools(context.Background(), activities.ResolveAgentToolsInput{AgentID: "x"})
	require.NoError(t, err)
	require.Empty(t, declared)
}
