package corpus_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

func TestRetrieveReturnsOnlyWhatTheSourceConfirmed(t *testing.T) {
	store := &fakeStore{hits: []vectorstore.Hit{
		chunkHit("c", "readable", "h1", 0.9),
		chunkHit("c", "restricted", "h2", 0.8),
	}}
	prober := &fakeProber{
		results: map[string]corpus.ProbeResult{
			"c/readable": {Allowed: true, Title: "Readable", URL: "u1", Version: "v1"},
		},
		errs: map[string]error{
			"c/restricted": &corpus.PermissionDenied{Err: errors.New("403")},
		},
	}

	outcome, err := corpus.Retrieve(context.Background(),
		[]vectorstore.Store{store}, prober, "q", []string{"reader"}, nil, 5, 3)

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 1)
	require.Equal(t, "Readable", outcome.Chunks[0].Title)
	require.Equal(t, 1, outcome.Denied)
}

func TestRetrieveOverFetchesSoProbeDropsDoNotStarveTheAnswer(t *testing.T) {
	// Twelve candidates exist; the answer wants 4. Asking the store for exactly
	// 4 would leave nothing in reserve when the source refuses some of them.
	hits := make([]vectorstore.Hit, 0, 12)
	for i := 0; i < 12; i++ {
		hits = append(hits, chunkHit("c", string(rune('a'+i)), string(rune('a'+i)), float32(12-i)/12))
	}
	store := &fakeStore{hits: hits}

	prober := &fakeProber{results: map[string]corpus.ProbeResult{}}
	for i := 0; i < 12; i++ {
		prober.results["c/"+string(rune('a'+i))] = corpus.ProbeResult{
			Allowed: true, Title: "t", URL: "u", Version: "v1",
		}
	}

	outcome, err := corpus.Retrieve(context.Background(),
		[]vectorstore.Store{store}, prober, "q", []string{"reader"}, nil, 4, 3)

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 4, "capped at the requested limit")
	require.Equal(t, 12, prober.probeCount(), "but 4*3 candidates were probed")
}

func TestRetrieveDefaultsAnAbsurdMultiplier(t *testing.T) {
	store := &fakeStore{hits: []vectorstore.Hit{chunkHit("c", "s", "h", 0.5)}}
	prober := &fakeProber{results: map[string]corpus.ProbeResult{
		"c/s": {Allowed: true, Title: "t", URL: "u", Version: "v1"},
	}}

	outcome, err := corpus.Retrieve(context.Background(),
		[]vectorstore.Store{store}, prober, "q", []string{"reader"}, nil, 2, 0)

	require.NoError(t, err)
	require.Len(t, outcome.Chunks, 1)
}

func TestRetrieveCarriesBothKindsOfMissingEvidence(t *testing.T) {
	healthy := &fakeStore{hits: []vectorstore.Hit{chunkHit("c", "busy", "h", 0.5)}}
	broken := &fakeStore{err: errors.New("qdrant down")}
	prober := &fakeProber{errs: map[string]error{
		"c/busy": &corpus.Transient{Err: errors.New("429")},
	}}

	outcome, err := corpus.Retrieve(context.Background(),
		[]vectorstore.Store{healthy, broken}, prober, "q", []string{"reader"}, nil, 5, 3)

	require.NoError(t, err)
	// A corpus that could not be searched and a source that could not be
	// checked are different failures, and an answer should be able to say both.
	require.Equal(t, 1, outcome.SkippedCorpora)
	require.Equal(t, []string{"c/busy"}, outcome.Undetermined)
	require.Empty(t, outcome.Chunks)
}

func TestBrokerProberSendsTheDelegatedTokenAndReadsTheProbe(t *testing.T) {
	var gotAuth, gotDelegated, gotPath string
	var gotBody map[string]string

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("authorization")
		gotDelegated = r.Header.Get("x-delegated-token")
		gotPath = r.URL.Path
		_ = json.NewDecoder(r.Body).Decode(&gotBody)
		_ = json.NewEncoder(w).Encode(corpus.ProbeResult{
			Allowed: true, Title: "Auth design", URL: "https://wiki/1", Version: "v7",
		})
	}))
	defer server.Close()

	prober := &corpus.BrokerProber{
		BaseURL: server.URL, Token: "orch-token", DelegatedToken: "user-token",
	}

	result, err := prober.Probe(context.Background(),
		corpus.ProbeRequest{CorpusID: "globex-confluence", SourceID: "page-1"})

	require.NoError(t, err)
	require.Equal(t, "Auth design", result.Title)
	require.Equal(t, "Bearer orch-token", gotAuth, "the orchestrator authenticates itself")
	require.Equal(t, "user-token", gotDelegated, "and forwards the user's own credential")
	require.Equal(t, "/connections/globex-confluence/probe", gotPath)
	require.Equal(t, "page-1", gotBody["sourceId"])
}

func TestBrokerProberClassifiesBrokerStatuses(t *testing.T) {
	for _, tc := range []struct {
		status int
		denied bool
	}{
		{http.StatusForbidden, true},
		{http.StatusNotFound, true},
		{http.StatusTooManyRequests, false},
		{http.StatusServiceUnavailable, false},
		{http.StatusInternalServerError, false},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(tc.status)
		}))

		prober := &corpus.BrokerProber{BaseURL: server.URL, Token: "t", DelegatedToken: "u"}
		_, err := prober.Probe(context.Background(), corpus.ProbeRequest{CorpusID: "c", SourceID: "s"})

		var denied *corpus.PermissionDenied
		var transient *corpus.Transient
		if tc.denied {
			require.ErrorAs(t, err, &denied, "status %d must drop the candidate", tc.status)
		} else {
			// Treating a busy broker as a denial would quietly shrink the answer.
			require.ErrorAs(t, err, &transient, "status %d must NOT be read as a denial", tc.status)
		}
		server.Close()
	}
}

func TestBrokerProberRefusesToProbeWithoutADelegatedCredential(t *testing.T) {
	prober := &corpus.BrokerProber{BaseURL: "http://unused", Token: "t"}

	_, err := prober.Probe(context.Background(), corpus.ProbeRequest{CorpusID: "c", SourceID: "s"})

	// Nothing to answer the question with; the broker would refuse it anyway.
	var denied *corpus.PermissionDenied
	require.ErrorAs(t, err, &denied)
}

func TestBrokerProberTreatsAnUnreachableBrokerAsTransient(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := server.URL
	server.Close() // nothing is listening now

	prober := &corpus.BrokerProber{BaseURL: url, Token: "t", DelegatedToken: "u"}
	_, err := prober.Probe(context.Background(), corpus.ProbeRequest{CorpusID: "c", SourceID: "s"})

	var transient *corpus.Transient
	require.ErrorAs(t, err, &transient)
}

func TestBrokerProberDefaultsToPerResourceGranularity(t *testing.T) {
	prober := &corpus.BrokerProber{
		Granularities: map[string]corpus.Granularity{"slack-eng": corpus.GranularityConnection},
	}

	require.Equal(t, corpus.GranularityConnection, prober.Granularity("slack-eng"))
	// Assuming per-connection for an unknown provider would let one allowed
	// resource vouch for every other candidate from that source.
	require.Equal(t, corpus.GranularityResource, prober.Granularity("something-new"))
}
