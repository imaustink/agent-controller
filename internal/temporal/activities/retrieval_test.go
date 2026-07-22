package activities_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

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
