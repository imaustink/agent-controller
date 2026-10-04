package corpus_test

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/corpus"
)

var citeSources = []corpus.Source{
	{N: 1, Title: "Project Details as of August 2026", URL: "https://wiki/details"},
	{N: 2, Title: "SNC Session 2 Assessment", URL: "https://wiki/session2"},
	{N: 3, Title: "Project Details as of August 2026", URL: "https://wiki/details"}, // second passage, same page
}

func TestLinkCitationsTurnsMarkersIntoTitledLinks(t *testing.T) {
	out, used := corpus.LinkCitations("The demo runs through September, per [1].", citeSources)

	require.Equal(t, "The demo runs through September, per [Project Details as of August 2026](https://wiki/details).", out)
	require.Equal(t, 1, used)
}

func TestLinkCitationsJoinsAClusterAndCollapsesTheSamePage(t *testing.T) {
	// [1] and [3] are two passages of one page: one link, not two identical ones.
	for _, in := range []string{"Scope grew [1][2][3].", "Scope grew [1], [2], [3].", "Scope grew [1, 2, 3]."} {
		out, used := corpus.LinkCitations(in, citeSources)
		require.Equal(t,
			"Scope grew [Project Details as of August 2026](https://wiki/details), [SNC Session 2 Assessment](https://wiki/session2).",
			out, in)
		require.Equal(t, 2, used, in)
	}
}

// The model only writes numbers; a number nobody issued is an invented
// citation, and it must not survive looking like a real one.
func TestLinkCitationsDropsANumberThatNamesNoSource(t *testing.T) {
	out, used := corpus.LinkCitations("Auth uses OIDC [9]. Budget is tight [2][9].", citeSources)

	require.Equal(t, "Auth uses OIDC. Budget is tight [SNC Session 2 Assessment](https://wiki/session2).", out)
	require.Equal(t, 1, used)
}

func TestLinkCitationsLeavesMarkdownLinkSyntaxAlone(t *testing.T) {
	in := "See [1](https://elsewhere) and the [docs][1]."
	out, used := corpus.LinkCitations(in, citeSources)

	require.Equal(t, in, out)
	require.Zero(t, used)
}

func TestLinkCitationsEscapesTitlesAndURLs(t *testing.T) {
	out, _ := corpus.LinkCitations("x [1]", []corpus.Source{{N: 1, Title: "Q3 [draft]", URL: "https://w/a b(c)"}})

	require.Equal(t, `x [Q3 \[draft\]](https://w/a%20b%28c%29)`, out)
}

func TestFinalizeCitationsLinksInlineWithoutAListWhenTheModelCited(t *testing.T) {
	out := corpus.FinalizeCitations("Two engagements are active [1][2].", citeSources, []string{"2 source(s) are outside your access."})

	require.Contains(t, out, "[Project Details as of August 2026](https://wiki/details)")
	require.NotContains(t, out, "Sources:", "inline citations replace the list")
	require.Contains(t, out, "What this answer could not see:\n- 2 source(s) are outside your access.")
}

// The safety net: an answer built on retrieved material is never shipped
// uncited just because the model wrote no markers.
func TestFinalizeCitationsFallsBackToADeduplicatedListWhenNothingWasCited(t *testing.T) {
	out := corpus.FinalizeCitations("Two engagements are active.", citeSources, nil)

	require.Contains(t, out, "Sources:\n- [Project Details as of August 2026](https://wiki/details)\n- [SNC Session 2 Assessment](https://wiki/session2)\n")
	require.Equal(t, 1, strings.Count(out, "https://wiki/details"), "one entry per page, not per passage")
}

func TestFinalizeCitationsWithNoSourcesLeavesTheAnswerAlone(t *testing.T) {
	require.Equal(t, "Nothing matched.", corpus.FinalizeCitations("Nothing matched.", nil, nil))
}
