package activities_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

func recentTool(members ...catalog.KnowledgeBaseExecMember) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID: "kb:snc/recent",
		KnowledgeBaseExec: &catalog.KnowledgeBaseExecSpec{
			KnowledgeBaseID: "snc", DisplayName: "SNC", Operation: "recent", Members: members,
		},
	}
}

// recentBroker answers /corpora/<name>/recent per corpus name, recording paths.
func recentBroker(t *testing.T, byCorpus map[string]any) (*httptest.Server, *[]string) {
	t.Helper()
	var asked []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		asked = append(asked, r.URL.Path+"?"+r.URL.RawQuery)
		require.Equal(t, "user-token", r.Header.Get("x-delegated-token"))
		for name, body := range byCorpus {
			if r.URL.Path == "/corpora/"+name+"/recent" {
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

func sncMembers() []catalog.KnowledgeBaseExecMember {
	slack := member("snc-slack-team", []string{"reader"}, "c1")
	slack.Label = "#team-snc"
	wiki := member("snc-confluence", []string{"reader"}, "c2")
	wiki.Label = "SNC Confluence"
	return []catalog.KnowledgeBaseExecMember{slack, wiki}
}

// Each source orders by its own clock; the answer is the merge, newest first,
// numbered on from the turn's earlier results. This CAN fail: without the
// merge the items come back in member order.
func TestRecentMergesEverySourceNewestFirst(t *testing.T) {
	srv, asked := recentBroker(t, map[string]any{
		"snc-slack-team": hits(map[string]string{"id": "C1/2", "title": "teams isn't starting", "url": "https://slack/2", "updatedAt": "2026-09-21T15:00:00Z"}),
		"snc-confluence": hits(map[string]string{"id": "p1", "title": "Monthly Prep", "url": "https://wiki/p1", "updatedAt": "2026-09-22T09:00:00Z"}),
	})

	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).RecentCorpus(context.Background(),
		activities.RecentCorpusInput{
			Caller:     activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:       recentTool(sncMembers()...),
			FirstIndex: 4,
		})

	require.NoError(t, err)
	require.Len(t, *asked, 2)
	require.Contains(t, (*asked)[0], "limit=10")
	newer, older := strings.Index(out.Result, "[4] Monthly Prep"), strings.Index(out.Result, "[5] teams isn't starting")
	require.True(t, newer >= 0 && older > newer, out.Result)
	require.Contains(t, out.Result, "reference: snc-confluence/p1")
	require.Equal(t, []corpus.Source{
		{N: 4, Title: "Monthly Prep", URL: "https://wiki/p1"},
		{N: 5, Title: "teams isn't starting", URL: "https://slack/2"},
	}, out.Sources)
}

func TestRecentNarrowsToTheNamedSource(t *testing.T) {
	for _, name := range []string{"#team-snc", "team-snc", "snc-slack-team"} {
		srv, asked := recentBroker(t, map[string]any{
			"snc-slack-team": hits(map[string]string{"id": "C1/2", "title": "m", "url": "u", "updatedAt": "2026-09-21T15:00:00Z"}),
		})
		_, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).RecentCorpus(context.Background(),
			activities.RecentCorpusInput{
				Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
				Tool:   recentTool(sncMembers()...),
				Source: name,
			})
		require.NoError(t, err)
		require.Len(t, *asked, 1, name)
		require.Contains(t, (*asked)[0], "/corpora/snc-slack-team/recent", name)
	}
}

// Silently widening to every source would answer a different question.
func TestRecentSaysSoWhenTheNamedSourceIsNotInTheKnowledgeBase(t *testing.T) {
	srv, asked := recentBroker(t, map[string]any{})
	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).RecentCorpus(context.Background(),
		activities.RecentCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   recentTool(sncMembers()...),
			Source: "#random",
		})
	require.NoError(t, err)
	require.Empty(t, *asked)
	require.Contains(t, out.Result, `"#random" is not a source in SNC`)
}

func TestRecentReportsASourceThatCannotListByTime(t *testing.T) {
	srv, _ := recentBroker(t, map[string]any{
		"snc-slack-team": hits(map[string]string{"id": "C1/2", "title": "m", "url": "u", "updatedAt": "2026-09-21T15:00:00Z"}),
		"snc-confluence": http.StatusNotFound,
	})
	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).RecentCorpus(context.Background(),
		activities.RecentCorpusInput{
			Caller: activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:   recentTool(sncMembers()...),
		})
	require.NoError(t, err)
	require.Contains(t, out.Result, "Could not check: SNC Confluence (cannot list recent items).")
}
