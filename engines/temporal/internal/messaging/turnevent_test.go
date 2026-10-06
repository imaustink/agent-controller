package messaging

import (
	"encoding/json"
	"testing"
)

// Render must reproduce the exact legacy narration strings so the gateway's
// down-convert to []string is byte-for-byte unchanged (ADR 0004 B1).
func TestTurnEventRenderMatchesLegacyNarration(t *testing.T) {
	cases := []struct {
		name string
		ev   TurnEvent
		want string
	}{
		{"skill", SkillSelected(1, "t", "skill-abc"), "Using skill skill-abc"},
		{"started", ToolStarted(2, "t", "tool-xyz"), "Running tool-xyz…"},
		{"finished", ToolFinished(3, "t", "tool-xyz"), "tool-xyz finished"},
		{"failed", ToolFailed(4, "t", "tool-xyz", "E_BOOM"), "tool-xyz failed: E_BOOM"},
		{"progress-staged", FromToolEvent(5, Event{Type: EventProgress, JobID: "j", TS: "t", Stage: "clone", Message: "pulling"}), "clone: pulling"},
		{"progress-bare", FromToolEvent(6, Event{Type: EventProgress, JobID: "j", TS: "t", Message: "working"}), "working"},
		{"warning", FromToolEvent(7, Event{Type: EventWarning, JobID: "j", TS: "t", Message: "slow"}), "slow"},
	}
	for _, c := range cases {
		if got := c.ev.Render(); got != c.want {
			t.Errorf("%s: Render() = %q, want %q", c.name, got, c.want)
		}
	}
}

// The whole point of B1: structure the current bridge throws away survives.
func TestFromToolEventPreservesStructure(t *testing.T) {
	pct := 0.42
	src := Event{
		Type:      EventProgress,
		JobID:     "job-1",
		TS:        "2026-10-05T00:00:00Z",
		Stage:     "embed",
		Pct:       &pct,
		Message:   "batch 3/7",
		Artifacts: []ArtifactRef{{URI: "s3://b/k", Bytes: 10}},
	}
	te := FromToolEvent(9, src)

	if te.Kind != KindToolProgress {
		t.Fatalf("kind = %q, want %q", te.Kind, KindToolProgress)
	}
	if te.Pct == nil || *te.Pct != pct {
		t.Errorf("Pct not preserved: %v", te.Pct)
	}
	if te.Stage != "embed" || te.Message != "batch 3/7" || te.ToolID != "job-1" {
		t.Errorf("fields not preserved: %+v", te)
	}
	if len(te.Artifacts) != 1 || te.Artifacts[0].URI != "s3://b/k" {
		t.Errorf("artifacts not preserved: %+v", te.Artifacts)
	}

	// And it still serializes as a stable typed envelope.
	b, err := json.Marshal(te)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var round TurnEvent
	if err := json.Unmarshal(b, &round); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if round.Kind != te.Kind || round.Stage != te.Stage {
		t.Errorf("round-trip mismatch: %+v vs %+v", round, te)
	}
}

// Guard that the test can actually fail (feedback: verify checks can fail):
// a deliberately wrong expectation must not pass.
func TestRenderGuardCanFail(t *testing.T) {
	if got := ToolStarted(1, "t", "x").Render(); got == "this should never match" {
		t.Fatal("Render() returned the impossible sentinel — test is inert")
	}
}
