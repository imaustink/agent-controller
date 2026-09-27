package corpus_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// aclHit is chunkHit plus the mirror fields this file is about.
func aclHit(hash string, principals []string, permissive bool) vectorstore.Hit {
	payload, err := json.Marshal(corpus.Chunk{
		CorpusID:      "globex-confluence",
		SourceID:      hash,
		SourceURL:     "https://wiki.test/" + hash,
		ContentHash:   hash,
		Text:          "body",
		ACLPrincipals: principals,
		ACLPermissive: permissive,
	})
	if err != nil {
		panic(err)
	}
	return vectorstore.Hit{ID: hash, Score: 0.5, Descriptor: payload}
}

// A prober that allows everything: the source says yes, so anything the
// pre-filter excluded is a harmful-direction miss by definition.
type allowAll struct{}

func (allowAll) Granularity(string) corpus.Granularity { return corpus.GranularityResource }
func (allowAll) Probe(context.Context, corpus.ProbeRequest) (corpus.ProbeResult, error) {
	return corpus.ProbeResult{Allowed: true, Title: "t", URL: "u"}, nil
}

// A prober that refuses everything, for measuring the harmless direction.
type denyAll struct{}

func (denyAll) Granularity(string) corpus.Granularity { return corpus.GranularityResource }
func (denyAll) Probe(context.Context, corpus.ProbeRequest) (corpus.ProbeResult, error) {
	return corpus.ProbeResult{}, &corpus.PermissionDenied{Err: errString("no")}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestSampleFindsTheHarmfulDirection(t *testing.T) {
	// Restricted to a group the caller's principal set covers and does not
	// match, so the mirror excludes it — but the source allows it.
	store := &fakeStore{hits: []vectorstore.Hit{aclHit("h1", []string{"group:finance"}, false)}}

	results, err := corpus.Sample(context.Background(), []vectorstore.Store{store}, allowAll{}, corpus.SampleConfig{
		Roles:      []string{"reader"},
		Principals: []string{"group:eng"},
		Queries:    []string{"anything"},
	})
	if err != nil {
		t.Fatal(err)
	}

	// The signal nothing else produces: the caller would have been told this
	// does not exist.
	if len(results[0].HarmfulMisses) != 1 {
		t.Fatalf("expected one harmful miss, got %+v", results[0])
	}
	if corpus.HarmfulMissRate(results) != 1 {
		t.Fatalf("rate = %v", corpus.HarmfulMissRate(results))
	}
}

func TestSampleReportsNoMissWhenTheMirrorWasRight(t *testing.T) {
	store := &fakeStore{hits: []vectorstore.Hit{aclHit("h1", []string{"group:finance"}, false)}}

	// The source also refuses it, so excluding it saved a probe and cost
	// nothing — the mirror working exactly as intended.
	results, err := corpus.Sample(context.Background(), []vectorstore.Store{store}, denyAll{}, corpus.SampleConfig{
		Roles:      []string{"reader"},
		Principals: []string{"group:eng"},
		Queries:    []string{"anything"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(results[0].HarmfulMisses) != 0 {
		t.Fatalf("expected no harmful miss, got %+v", results[0])
	}
	if results[0].PreFiltered != 1 {
		t.Fatalf("expected the saving to be reported, got %+v", results[0])
	}
}

func TestSampleCountsWastedProbes(t *testing.T) {
	// Kept by the mirror (permissive), refused by the source: the harmless
	// direction, and what the mirror's optimism costs.
	store := &fakeStore{hits: []vectorstore.Hit{aclHit("h1", nil, true)}}

	results, err := corpus.Sample(context.Background(), []vectorstore.Store{store}, denyAll{}, corpus.SampleConfig{
		Roles:      []string{"reader"},
		Principals: []string{"user:someone"},
		Queries:    []string{"anything"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if results[0].WastedProbes != 1 || len(results[0].HarmfulMisses) != 0 {
		t.Fatalf("got %+v", results[0])
	}
}

func TestSampleWithNoQueriesDoesNothing(t *testing.T) {
	results, err := corpus.Sample(context.Background(), nil, allowAll{}, corpus.SampleConfig{})
	if err != nil || results != nil {
		t.Fatalf("got %v %v", results, err)
	}
}
