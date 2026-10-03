package corpus

import (
	"sort"
	"strings"
	"unicode"
)

// Rerank blends the two weights below when ordering the authorized set before it
// is cut to the answer's limit.
//
// Vector recall alone surfaces passages that are semantically near the question
// but miss the exact terms the asker used — a client name, a system, an acronym
// — and a passage that literally contains those terms is usually the better
// citation. Blending keeps semantic recall while pulling term-exact passages up.
// Deliberately NOT an external reranker model: the weights are fixed and the
// sort is stable, so the same question returns the same order, with no new
// dependency, secret, or per-query network cost. PARITY: rerank.ts.
const (
	rerankWeightVector  = 0.7
	rerankWeightKeyword = 0.3
)

// rerank reorders authorized chunks by a blend of normalized vector score and
// query-keyword overlap, highest first, with a deterministic tie-break.
//
// It never adds or drops a chunk — only the order changes — so every access
// guarantee the probe established still holds, and the caller's later `[:limit]`
// cut now keeps the most relevant `limit`, not merely the highest-cosine ones.
func rerank(query string, chunks []AuthorizedChunk) []AuthorizedChunk {
	if len(chunks) < 2 {
		return chunks
	}
	terms := keywordSet(query)

	// Min-max normalize vector scores across this set. Cosine scores are only
	// meaningful relative to one another, and a fixed scale would let one
	// component dominate purely because of its range.
	min, max := chunks[0].Score, chunks[0].Score
	for _, c := range chunks {
		if c.Score < min {
			min = c.Score
		}
		if c.Score > max {
			max = c.Score
		}
	}
	span := float64(max - min)

	type scored struct {
		chunk    AuthorizedChunk
		combined float64
	}
	ranked := make([]scored, len(chunks))
	for i, c := range chunks {
		norm := 1.0
		if span > 0 {
			norm = float64(c.Score-min) / span
		}
		combined := rerankWeightVector*norm +
			rerankWeightKeyword*keywordOverlap(terms, c.Chunk.Title, c.Chunk.Text)
		ranked[i] = scored{chunk: c, combined: combined}
	}

	sort.SliceStable(ranked, func(i, j int) bool {
		if ranked[i].combined != ranked[j].combined {
			return ranked[i].combined > ranked[j].combined
		}
		// Same blended score: fall back to the existing deterministic order, so a
		// tie never depends on probe-completion timing.
		a, b := ranked[i].chunk, ranked[j].chunk
		if a.Score != b.Score {
			return a.Score > b.Score
		}
		if a.Chunk.CorpusID != b.Chunk.CorpusID {
			return a.Chunk.CorpusID < b.Chunk.CorpusID
		}
		return a.Chunk.SourceID < b.Chunk.SourceID
	})

	out := make([]AuthorizedChunk, len(ranked))
	for i, r := range ranked {
		out[i] = r.chunk
	}
	return out
}

// keywordOverlap is the fraction of distinct query terms that appear in the
// chunk's title or text, in [0,1].
func keywordOverlap(terms map[string]struct{}, title, text string) float64 {
	if len(terms) == 0 {
		return 0
	}
	haystack := tokenize(title + " " + text)
	hits := 0
	for term := range terms {
		if _, ok := haystack[term]; ok {
			hits++
		}
	}
	return float64(hits) / float64(len(terms))
}

func keywordSet(query string) map[string]struct{} {
	return tokenize(query)
}

// tokenize lowercases, splits on any non-alphanumeric rune, drops tokens shorter
// than three runes and a small set of common words, and returns the distinct
// remainder. The stop list is deliberately tiny: it exists only to stop
// "the"/"and" from making every chunk look equally relevant, not to do real
// linguistic stemming.
func tokenize(s string) map[string]struct{} {
	fields := strings.FieldsFunc(strings.ToLower(s), func(r rune) bool {
		return !unicode.IsLetter(r) && !unicode.IsNumber(r)
	})
	out := make(map[string]struct{}, len(fields))
	for _, f := range fields {
		if len([]rune(f)) < 3 || isStopWord(f) {
			continue
		}
		out[f] = struct{}{}
	}
	return out
}

var stopWords = map[string]struct{}{
	"the": {}, "and": {}, "for": {}, "are": {}, "what": {}, "which": {},
	"with": {}, "that": {}, "this": {}, "from": {}, "have": {}, "has": {},
	"can": {}, "you": {}, "our": {}, "was": {}, "were": {}, "about": {},
	"into": {}, "how": {}, "does": {}, "did": {}, "they": {}, "them": {},
}

func isStopWord(w string) bool {
	_, ok := stopWords[w]
	return ok
}
