package corpus_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/corpus"
)

// allowProbe answers every probe with a readable result, recording the
// delegated token each request carried.
func allowProbe(seen *[]string) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*seen = append(*seen, r.Header.Get("x-delegated-token"))
		w.Header().Set("content-type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"allowed": true, "title": "t", "url": "u"})
	}))
}

func TestBrokerProbesEachConnectionWithItsOwnProvidersToken(t *testing.T) {
	var seen []string
	srv := allowProbe(&seen)
	defer srv.Close()

	prober := &corpus.BrokerProber{
		BaseURL: srv.URL,
		Token:   "orch",
		DelegatedTokens: map[string]string{
			"conf": "atlassian-token",
			"chan": "slack-token",
		},
	}

	_, err := prober.Probe(context.Background(), corpus.ProbeRequest{CorpusID: "conf", SourceID: "p1"})
	require.NoError(t, err)
	_, err = prober.Probe(context.Background(), corpus.ProbeRequest{CorpusID: "chan"})
	require.NoError(t, err)

	// The whole point: a Slack channel is probed with the Slack token, not the
	// Atlassian one — probing it with the wrong token is a silent drop, not a
	// denial.
	require.Equal(t, []string{"atlassian-token", "slack-token"}, seen)
}

func TestBrokerFallsBackToTheSingleDelegatedTokenForAConnectionNotInTheMap(t *testing.T) {
	var seen []string
	srv := allowProbe(&seen)
	defer srv.Close()

	prober := &corpus.BrokerProber{
		BaseURL:         srv.URL,
		Token:           "orch",
		DelegatedToken:  "fallback",
		DelegatedTokens: map[string]string{"other": "x"},
	}

	_, err := prober.Probe(context.Background(), corpus.ProbeRequest{CorpusID: "conf", SourceID: "p"})
	require.NoError(t, err)

	require.Equal(t, []string{"fallback"}, seen)
}
