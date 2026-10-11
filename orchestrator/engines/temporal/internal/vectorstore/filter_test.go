package vectorstore

import "testing"

// The point of `hidden` (agent-controller ADR 0039 §2): a knowledge base's
// generated tools are reachable because the skill that owns them declared them
// by id, and are kept out of open retrieval so every client's scoped tooling
// does not compete in front of every caller.
//
// These assert the two halves of that split directly, since exercising the
// filters through a live Qdrant needs the integration test's server.
func TestQueryFilterExcludesHiddenRecords(t *testing.T) {
	filter := queryFilter([]string{"reader"})

	if len(filter.MustNot) != 1 {
		t.Fatalf("expected one must-not condition, got %d", len(filter.MustNot))
	}
	match := filter.MustNot[0].GetField()
	if match == nil || match.Key != "hidden" {
		t.Fatalf("expected the must-not to key on `hidden`, got %+v", filter.MustNot[0])
	}
	if !match.GetMatch().GetBoolean() {
		t.Error("expected the must-not to exclude hidden=true")
	}

	// The role filter still has to be there — hiding must not replace RBAC.
	if len(filter.Should) == 0 {
		t.Error("expected the role visibility conditions to survive")
	}
}

func TestGetByIDsFilterKeepsHiddenRecordsReachable(t *testing.T) {
	// visibilityFilter is what GetByIDs uses. If it excluded hidden records,
	// a selected knowledge base would resolve none of its own declared tools.
	filter := visibilityFilter([]string{"reader"})

	if len(filter.MustNot) != 0 {
		t.Errorf("id lookups must not exclude hidden records, got %+v", filter.MustNot)
	}
}
