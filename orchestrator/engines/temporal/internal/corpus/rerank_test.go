package corpus

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func authChunk(score float32, title, text, corpusID, sourceID string) AuthorizedChunk {
	return AuthorizedChunk{
		Score: score,
		Title: title,
		Chunk: Chunk{CorpusID: corpusID, SourceID: sourceID, Title: title, Text: text},
	}
}

func sourceOrder(chunks []AuthorizedChunk) []string {
	out := make([]string, len(chunks))
	for i, c := range chunks {
		out[i] = c.Chunk.SourceID
	}
	return out
}

func TestRerankPromotesKeywordMatchWithinScoreBand(t *testing.T) {
	// Pure vector order is C (0.9), A (0.6), B (0.55). Only B contains every query
	// term; the keyword weight is enough to lift it above A — which contains none
	// — while C stays on top.
	//
	// This CAN fail: with the keyword weight at zero the order would stay
	// C, A, B, so the assertion genuinely exercises the blend rather than the
	// vector order it would have had anyway.
	query := "migration pipeline schema"
	chunks := []AuthorizedChunk{
		authChunk(0.90, "Overview", "general notes about the client", "c1", "s-c"),
		authChunk(0.60, "Notes", "unrelated meeting discussion", "c1", "s-a"),
		authChunk(0.55, "Plan", "the migration pipeline schema rollout plan", "c1", "s-b"),
	}

	require.Equal(t, []string{"s-c", "s-b", "s-a"}, sourceOrder(rerank(query, chunks)))
}

func TestRerankKeepsVectorOrderWhenNoKeywordMatches(t *testing.T) {
	query := "migration pipeline schema"
	chunks := []AuthorizedChunk{
		authChunk(0.90, "A", "nothing relevant here", "c1", "s-a"),
		authChunk(0.50, "B", "also nothing of interest", "c1", "s-b"),
	}

	require.Equal(t, []string{"s-a", "s-b"}, sourceOrder(rerank(query, chunks)))
}

func TestRerankTieBreaksDeterministically(t *testing.T) {
	// Identical score and no keyword signal: order must come from the stable
	// tie-break (corpus id, then source id), not input or map order.
	chunks := []AuthorizedChunk{
		authChunk(0.5, "", "", "c2", "s2"),
		authChunk(0.5, "", "", "c1", "s9"),
		authChunk(0.5, "", "", "c1", "s1"),
	}

	require.Equal(t, []string{"s1", "s9", "s2"}, sourceOrder(rerank("anything here", chunks)))
}

func TestRerankIsNoOpBelowTwoChunks(t *testing.T) {
	require.Empty(t, rerank("q", nil))
	one := []AuthorizedChunk{authChunk(0.1, "t", "x", "c", "s")}
	require.Equal(t, one, rerank("q", one))
}
