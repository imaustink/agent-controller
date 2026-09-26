package corpus_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/corpus"
)

// fakeProber answers per (connection, source), counts the probes it was
// actually asked to make, and can be switched to connection granularity.
type fakeProber struct {
	granularity corpus.Granularity
	results     map[string]corpus.ProbeResult
	errs        map[string]error

	mu     sync.Mutex
	probes []corpus.ProbeRequest
}

func (f *fakeProber) Granularity(string) corpus.Granularity {
	if f.granularity == "" {
		return corpus.GranularityResource
	}
	return f.granularity
}

func (f *fakeProber) Probe(_ context.Context, req corpus.ProbeRequest) (corpus.ProbeResult, error) {
	f.mu.Lock()
	f.probes = append(f.probes, req)
	f.mu.Unlock()

	key := req.CorpusID + "/" + req.SourceID
	if err, ok := f.errs[key]; ok {
		return corpus.ProbeResult{}, err
	}
	if result, ok := f.results[key]; ok {
		return result, nil
	}
	return corpus.ProbeResult{Allowed: false}, nil
}

func (f *fakeProber) probeCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.probes)
}

func candidate(connectionID, sourceID, version string, score float32) corpus.Hit {
	return corpus.Hit{
		Score: score,
		Chunk: corpus.Chunk{
			CorpusID: connectionID,
			SourceID: sourceID,
			Version:  version,
			// Deliberately misleading mirror metadata: Authorize must never let
			// these reach a citation.
			Title:       "STALE MIRROR TITLE",
			SourceURL:   "https://mirror.invalid/leaked",
			ContentHash: connectionID + sourceID + version,
			Text:        "…passage…",
		},
	}
}

func TestAuthorizeTakesCitationFieldsFromTheProbeNotTheMirror(t *testing.T) {
	prober := &fakeProber{results: map[string]corpus.ProbeResult{
		"snc-confluence/page-1": {
			Allowed: true,
			Title:   "Auth design",
			URL:     "https://example.atlassian.net/wiki/page-1",
			Version: "v7",
		},
	}}

	outcome, err := corpus.Authorize(context.Background(), prober,
		[]corpus.Hit{candidate("snc-confluence", "page-1", "v7", 0.9)})

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 1)
	// Citations are content: a title or URL taken from the mirror would bypass
	// the whole design at the last step.
	require.Equal(t, "Auth design", outcome.Chunks[0].Title)
	require.Equal(t, "https://example.atlassian.net/wiki/page-1", outcome.Chunks[0].URL)
	require.NotContains(t, outcome.Chunks[0].URL, "mirror.invalid")
}

func TestAuthorizeDropsWhatTheSourceRefuses(t *testing.T) {
	prober := &fakeProber{
		results: map[string]corpus.ProbeResult{
			"snc-confluence/page-1": {Allowed: true, Title: "Readable", URL: "u", Version: "v1"},
		},
		errs: map[string]error{
			"snc-confluence/page-2": &corpus.PermissionDenied{Err: errors.New("403")},
		},
	}

	outcome, err := corpus.Authorize(context.Background(), prober, []corpus.Hit{
		candidate("snc-confluence", "page-1", "v1", 0.9),
		candidate("snc-confluence", "page-2", "v1", 0.8),
	})

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 1)
	require.Equal(t, 1, outcome.Denied)
	require.Empty(t, outcome.Undetermined)
}

func TestAuthorizeTreatsAllowedFalseAsADenial(t *testing.T) {
	prober := &fakeProber{results: map[string]corpus.ProbeResult{
		"c/s": {Allowed: false},
	}}

	outcome, err := corpus.Authorize(context.Background(), prober,
		[]corpus.Hit{candidate("c", "s", "v1", 0.5)})

	require.NoError(t, err)
	require.Empty(t, outcome.Chunks)
	require.Equal(t, 1, outcome.Denied)
}

func TestAuthorizeDoesNotSilentlyDropOnATransientFailure(t *testing.T) {
	prober := &fakeProber{
		results: map[string]corpus.ProbeResult{
			"c/ok": {Allowed: true, Title: "t", URL: "u", Version: "v1"},
		},
		errs: map[string]error{
			"c/busy": &corpus.Transient{Err: errors.New("429 rate limited")},
		},
	}

	outcome, err := corpus.Authorize(context.Background(), prober, []corpus.Hit{
		candidate("c", "ok", "v1", 0.9),
		candidate("c", "busy", "v1", 0.8),
	})

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 1)
	// A 429 is not a denial. Counting it as one would quietly shrink the answer
	// and make the same question return different evidence on a retry.
	require.Zero(t, outcome.Denied)
	require.Equal(t, []string{"c/busy"}, outcome.Undetermined)
}

func TestAuthorizeFailsOnAnUnclassifiedDriverError(t *testing.T) {
	prober := &fakeProber{errs: map[string]error{
		"c/s": errors.New("driver forgot to classify this"),
	}}

	_, err := corpus.Authorize(context.Background(), prober,
		[]corpus.Hit{candidate("c", "s", "v1", 0.5)})

	// Guessing whether an unclassified error meant "denied" or "busy" is how a
	// leak gets introduced, so it fails the search instead.
	require.Error(t, err)
}

func TestAuthorizeDeduplicatesProbesPerSource(t *testing.T) {
	prober := &fakeProber{results: map[string]corpus.ProbeResult{
		"c/page-1": {Allowed: true, Title: "t", URL: "u", Version: "v1"},
	}}

	hits := make([]corpus.Hit, 0, 8)
	for i := 0; i < 8; i++ {
		hit := candidate("c", "page-1", "v1", float32(i)/10)
		hit.Chunk.ContentHash = string(rune('a' + i)) // eight chunks, one page
		hits = append(hits, hit)
	}

	outcome, err := corpus.Authorize(context.Background(), prober, hits)

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 8)
	require.Equal(t, 1, prober.probeCount(),
		"eight chunks from one page must cost one probe, not eight")
}

func TestAuthorizeProbesOncePerConnectionForChannelScopedProviders(t *testing.T) {
	// Slack authorizes a CHANNEL: membership is the access unit, so one probe
	// settles every candidate from that connection.
	prober := &fakeProber{
		granularity: corpus.GranularityConnection,
		results: map[string]corpus.ProbeResult{
			"snc-slack-eng/": {Allowed: true, Title: "#snc-eng", URL: "u", Version: ""},
		},
	}

	outcome, err := corpus.Authorize(context.Background(), prober, []corpus.Hit{
		candidate("snc-slack-eng", "msg-1", "", 0.9),
		candidate("snc-slack-eng", "msg-2", "", 0.8),
		candidate("snc-slack-eng", "msg-3", "", 0.7),
	})

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 3)
	require.Equal(t, 1, prober.probeCount())
}

func TestAuthorizeMarksStaleWhenTheSourceHasMovedOn(t *testing.T) {
	prober := &fakeProber{results: map[string]corpus.ProbeResult{
		"c/page-1": {Allowed: true, Title: "t", URL: "u", Version: "v9"},
		"c/page-2": {Allowed: true, Title: "t", URL: "u", Version: "v2"},
		"c/page-3": {Allowed: true, Title: "t", URL: "u", Version: ""},
	}}

	outcome, err := corpus.Authorize(context.Background(), prober, []corpus.Hit{
		candidate("c", "page-1", "v7", 0.9), // indexed at v7, source at v9
		candidate("c", "page-2", "v2", 0.8), // current
		candidate("c", "page-3", "v1", 0.7), // provider reports no version
	})

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 3)
	require.True(t, outcome.Chunks[0].Stale, "readable but overtaken — not dropped, just old")
	require.False(t, outcome.Chunks[1].Stale)
	require.False(t, outcome.Chunks[2].Stale,
		"a provider that reports no version cannot be shown to be stale, so do not claim it is")
}

func TestAuthorizePreservesRankOrder(t *testing.T) {
	prober := &fakeProber{results: map[string]corpus.ProbeResult{
		"c/a": {Allowed: true, Title: "a", URL: "ua", Version: "v1"},
		"c/b": {Allowed: true, Title: "b", URL: "ub", Version: "v1"},
		"c/c": {Allowed: true, Title: "c", URL: "uc", Version: "v1"},
	}}

	outcome, err := corpus.Authorize(context.Background(), prober, []corpus.Hit{
		candidate("c", "a", "v1", 0.9),
		candidate("c", "b", "v1", 0.5),
		candidate("c", "c", "v1", 0.1),
	})

	require.NoError(t, err)
	require.Equal(t, []string{"a", "b", "c"},
		[]string{outcome.Chunks[0].Title, outcome.Chunks[1].Title, outcome.Chunks[2].Title})
}

func TestAuthorizeWithNoCandidates(t *testing.T) {
	outcome, err := corpus.Authorize(context.Background(), &fakeProber{}, nil)
	require.NoError(t, err)
	require.Empty(t, outcome.Chunks)
}
