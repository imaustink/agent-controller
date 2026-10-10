package corpus_test

import (
	"testing"

	"github.com/controller-agent/temporal-engine/internal/corpus"
)

func hit(principals []string, permissive bool) corpus.Hit {
	return corpus.Hit{Chunk: corpus.Chunk{
		SourceID:      "page-1",
		ACLPrincipals: principals,
		ACLPermissive: permissive,
	}}
}

func TestPreFilterDropsOnlyWhenTheMirrorIsConfident(t *testing.T) {
	caller := []string{"user:acc-1", "group:eng"}

	cases := []struct {
		name    string
		hit     corpus.Hit
		dropped bool
	}{
		{"restricted to someone else", hit([]string{"user:acc-2"}, false), true},
		{"restricted to a group the caller is not in", hit([]string{"group:finance"}, false), true},
		{"restricted to the caller", hit([]string{"user:acc-1"}, false), false},
		{"restricted to the caller's group", hit([]string{"group:eng"}, false), false},
		{"one of several matches", hit([]string{"user:acc-9", "group:eng"}, false), false},
		// Permissive and empty both mean "not a usable exclusion set", for
		// different reasons, and neither may drop anything.
		{"permissive", hit([]string{"user:acc-2"}, true), false},
		{"no restrictions at all", hit(nil, false), false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			kept, dropped := corpus.PreFilter([]corpus.Hit{tc.hit}, caller)
			if tc.dropped && (len(kept) != 0 || dropped != 1) {
				t.Fatalf("expected the candidate to be dropped, kept %d dropped %d", len(kept), dropped)
			}
			if !tc.dropped && (len(kept) != 1 || dropped != 0) {
				t.Fatalf("expected the candidate to be kept, kept %d dropped %d", len(kept), dropped)
			}
		})
	}
}

// The failure this function is mostly written to avoid: a caller whose group
// memberships have not been resolved holds only "user:" principals, and a
// group-restricted page matches none of them. Dropping on that basis would hide
// every group-restricted page from exactly the people entitled to read it, and
// would do it silently.
func TestPreFilterWillNotExcludeOnAKindItCannotEvaluate(t *testing.T) {
	onlyUserKnown := []string{"user:acc-1"}

	kept, dropped := corpus.PreFilter([]corpus.Hit{hit([]string{"group:eng"}, false)}, onlyUserKnown)

	if len(kept) != 1 || dropped != 0 {
		t.Fatalf("a group restriction must survive a caller with no group principals; kept %d dropped %d",
			len(kept), dropped)
	}
}

func TestPreFilterExcludesOnAMixOnlyWhenEveryKindIsCovered(t *testing.T) {
	// user is covered and does not match; group is NOT covered. Undecidable.
	kept, _ := corpus.PreFilter(
		[]corpus.Hit{hit([]string{"user:acc-2", "group:finance"}, false)},
		[]string{"user:acc-1"},
	)
	if len(kept) != 1 {
		t.Fatal("a chunk naming an unevaluable kind must be kept")
	}

	// Both kinds covered, neither matches. Now it is decidable.
	kept, dropped := corpus.PreFilter(
		[]corpus.Hit{hit([]string{"user:acc-2", "group:finance"}, false)},
		[]string{"user:acc-1", "group:eng"},
	)
	if len(kept) != 0 || dropped != 1 {
		t.Fatalf("expected a drop once every kind is evaluable; kept %d dropped %d", len(kept), dropped)
	}
}

func TestPreFilterWithNoCallerPrincipalsFiltersNothing(t *testing.T) {
	// An identity we could not resolve is not evidence of exclusion, and the
	// probes still gate every candidate — so the cost is latency, not a leak.
	hits := []corpus.Hit{hit([]string{"user:acc-2"}, false), hit([]string{"group:finance"}, false)}

	kept, dropped := corpus.PreFilter(hits, nil)

	if len(kept) != 2 || dropped != 0 {
		t.Fatalf("kept %d dropped %d", len(kept), dropped)
	}
}

func TestPreFilterHandlesProviderIdsContainingColons(t *testing.T) {
	// Atlassian account ids look like "557058:0e9503b6-..." — only the FIRST
	// colon separates the kind, or every such principal reads as kind "user"
	// versus kind "557058" and never matches.
	caller := []string{"user:557058:0e9503b6-3eb2-437d-9373-7dc8062ac23c"}
	kept, dropped := corpus.PreFilter(
		[]corpus.Hit{hit([]string{"user:557058:0e9503b6-3eb2-437d-9373-7dc8062ac23c"}, false)},
		caller,
	)
	if len(kept) != 1 || dropped != 0 {
		t.Fatalf("an exact match must be kept; kept %d dropped %d", len(kept), dropped)
	}
}
