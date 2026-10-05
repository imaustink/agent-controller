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

func queryTool(members ...catalog.KnowledgeBaseExecMember) catalog.ToolDescriptor {
	return catalog.ToolDescriptor{
		ID: "kb:snc/query",
		KnowledgeBaseExec: &catalog.KnowledgeBaseExecSpec{
			KnowledgeBaseID: "snc", DisplayName: "SNC", Operation: "query", Members: members,
		},
	}
}

type brokerQuery struct {
	corpus string
	body   activities.SourceQuery
}

// queryBroker answers POST /corpora/<name>/query per corpus name and records
// the filter each corpus was sent.
func queryBroker(t *testing.T, byCorpus map[string]any) (*httptest.Server, *[]brokerQuery) {
	t.Helper()
	var asked []brokerQuery
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		require.Equal(t, "user-token", r.Header.Get("x-delegated-token"))
		var body activities.SourceQuery
		require.NoError(t, json.NewDecoder(r.Body).Decode(&body))
		name := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/corpora/"), "/query")
		asked = append(asked, brokerQuery{corpus: name, body: body})

		reply, ok := byCorpus[name]
		if !ok {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if status, isStatus := reply.(int); isStatus {
			w.WriteHeader(status)
			return
		}
		w.Header().Set("content-type", "application/json")
		require.NoError(t, json.NewEncoder(w).Encode(reply))
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

func runQuery(t *testing.T, srv *httptest.Server, query string, first int) activities.QueryCorpusOutput {
	t.Helper()
	out, err := lookupActivities(srv, &fakeResolver{token: "user-token"}).QueryCorpus(context.Background(),
		activities.QueryCorpusInput{
			Caller:     activities.Caller{Subject: "s", Roles: []string{"reader"}},
			Tool:       queryTool(sncMembers()...),
			Query:      query,
			FirstIndex: first,
		})
	require.NoError(t, err)
	return out
}

// The planner's filter reaches each source intact (minus `source`, which only
// picks members), with the defaults applied.
func TestQuerySendsTheStructuredFilterToEachSource(t *testing.T) {
	srv, asked := queryBroker(t, map[string]any{
		"snc-slack-team": hits(), "snc-confluence": hits(),
	})

	runQuery(t, srv, `{"author":"Brad","after":"2026-09-01","before":"2026-10-01","type":"page"}`, 1)

	require.Len(t, *asked, 2)
	require.Equal(t, activities.SourceQuery{
		Author: "Brad", After: "2026-09-01", Before: "2026-10-01", Type: "page",
		Sort: "newest", Limit: 10, // no text: newest first by default
	}, (*asked)[0].body)
}

// Plain words are a keyword query; with keywords the default is relevance.
func TestQueryTakesPlainWordsAsKeywords(t *testing.T) {
	srv, asked := queryBroker(t, map[string]any{"snc-slack-team": hits(), "snc-confluence": hits()})

	runQuery(t, srv, "retro action items", 1)

	require.Equal(t, "retro action items", (*asked)[0].body.Text)
	require.Equal(t, "relevance", (*asked)[0].body.Sort)
}

// Each source orders by its own clock; a time sort is the merge, numbered on
// from the turn's earlier results. This CAN fail: without the merge the items
// come back in member order.
func TestQueryMergesATimeSortAcrossSources(t *testing.T) {
	srv, _ := queryBroker(t, map[string]any{
		"snc-slack-team": hits(map[string]string{"id": "C1/2", "title": "teams isn't starting", "url": "https://slack/2", "updatedAt": "2026-09-21T15:00:00Z"}),
		"snc-confluence": hits(map[string]string{"id": "p1", "title": "Monthly Prep", "url": "https://wiki/p1", "updatedAt": "2026-09-22T09:00:00Z"}),
	})

	out := runQuery(t, srv, `{"sort":"newest"}`, 4)

	newer, older := strings.Index(out.Result, "[4] Monthly Prep"), strings.Index(out.Result, "[5] teams isn't starting")
	require.True(t, newer >= 0 && older > newer, out.Result)
	require.Contains(t, out.Result, "reference: snc-confluence/p1")
	require.Equal(t, []corpus.Source{
		{N: 4, Title: "Monthly Prep", URL: "https://wiki/p1"},
		{N: 5, Title: "teams isn't starting", URL: "https://slack/2"},
	}, out.Sources)

	oldest := runQuery(t, srv, `{"sort":"oldest"}`, 1)
	require.Less(t, strings.Index(oldest.Result, "teams isn't starting"), strings.Index(oldest.Result, "Monthly Prep"))
}

// Relevance scores are not comparable across providers, so a relevance query
// interleaves sources in turn rather than pretending to rank them together.
func TestQueryInterleavesRelevanceAcrossSources(t *testing.T) {
	srv, _ := queryBroker(t, map[string]any{
		"snc-slack-team": hits(
			map[string]string{"id": "s1", "title": "slack best", "url": "u1"},
			map[string]string{"id": "s2", "title": "slack second", "url": "u2"}),
		"snc-confluence": hits(map[string]string{"id": "w1", "title": "wiki best", "url": "u3"}),
	})

	out := runQuery(t, srv, `{"text":"retro"}`, 1)

	require.Equal(t, []string{"slack best", "wiki best", "slack second"},
		[]string{out.Sources[0].Title, out.Sources[1].Title, out.Sources[2].Title})
}

// A source that cannot apply a filter refuses; its results would not be what
// was asked for, so they are reported as a refusal, never shown as matches.
func TestQueryReportsAFilterASourceCannotApply(t *testing.T) {
	srv, _ := queryBroker(t, map[string]any{
		"snc-slack-team": map[string]any{"hits": []any{}, "unsupported": []string{"title"}},
		"snc-confluence": hits(map[string]string{"id": "p1", "title": "Retro", "url": "u", "updatedAt": "2026-09-22T09:00:00Z"}),
	})

	out := runQuery(t, srv, `{"title":"retro"}`, 1)

	require.Contains(t, out.Result, "Could not query: #team-snc (cannot filter by title).")
	require.Len(t, out.Sources, 1)
}

func TestQueryNarrowsToTheNamedSource(t *testing.T) {
	for _, name := range []string{"#team-snc", "team-snc", "snc-slack-team"} {
		srv, asked := queryBroker(t, map[string]any{"snc-slack-team": hits()})
		runQuery(t, srv, `{"source":"`+name+`","sort":"newest"}`, 1)
		require.Len(t, *asked, 1, name)
		require.Equal(t, "snc-slack-team", (*asked)[0].corpus, name)
	}
}

// A malformed or unknown filter is the planner's to fix, so it comes back as
// prose naming the problem — and nothing is sent to any source.
func TestQueryExplainsAnUnusableFilterWithoutAskingAnyone(t *testing.T) {
	cases := map[string]string{
		`{"after":"last week"}`:  `use YYYY-MM-DD`,
		`{"sort":"popular"}`:     `not a sort`,
		`{"when":"recently"}`:    `not usable`,
		`{"source":"#random"}`:   `"#random" is not a source in SNC`,
		`{"text": "unterminated`: `not usable`,
	}
	for input, want := range cases {
		srv, asked := queryBroker(t, map[string]any{})
		out := runQuery(t, srv, input, 1)
		require.Contains(t, out.Result, want, input)
		require.Empty(t, *asked, input)
	}
}
