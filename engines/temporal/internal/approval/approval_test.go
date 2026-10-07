package approval

import "testing"

func TestResolvePrecedence(t *testing.T) {
	cases := []struct {
		tool, agent, want string
	}{
		{"", "", PolicyNever},            // both empty -> never
		{"always", "", PolicyAlways},     // tool set
		{"", "always", PolicyAlways},     // agent default
		{"never", "always", PolicyNever}, // tool wins over agent default
		{"auto", "never", PolicyAuto},    // tool wins
		{"ALWAYS", "", PolicyAlways},     // case-insensitive
		{"  always  ", "", PolicyAlways}, // trimmed
	}
	for _, c := range cases {
		if got := Resolve(c.tool, c.agent); got != c.want {
			t.Errorf("Resolve(%q,%q)=%q want %q", c.tool, c.agent, got, c.want)
		}
	}
}

func TestRequiresHuman(t *testing.T) {
	for _, p := range []string{PolicyAlways, PolicyAuto, "ALWAYS"} {
		if !RequiresHuman(p) {
			t.Errorf("RequiresHuman(%q) = false, want true", p)
		}
	}
	for _, p := range []string{PolicyNever, "", "nonsense"} {
		if RequiresHuman(p) {
			t.Errorf("RequiresHuman(%q) = true, want false", p)
		}
	}
}

func TestParseDecision(t *testing.T) {
	approve := []string{"approve", "YES", " ok ", "approved.", "allow", "confirm!"}
	deny := []string{"deny", "No", "reject", "cancel", "stop", "denied."}
	pending := []string{"", "maybe", "run it later", "approve the other one", "idk"}

	for _, m := range approve {
		if ParseDecision(m) != DecisionApproved {
			t.Errorf("ParseDecision(%q) != approved", m)
		}
	}
	for _, m := range deny {
		if ParseDecision(m) != DecisionDenied {
			t.Errorf("ParseDecision(%q) != denied", m)
		}
	}
	for _, m := range pending {
		if ParseDecision(m) != DecisionPending {
			t.Errorf("ParseDecision(%q) != pending", m)
		}
	}
}

// Guard: a free-text sentence that merely contains "approve" must NOT be read as
// approval — otherwise the gate would execute on ambiguous input.
func TestParseDecisionDoesNotMatchSubstrings(t *testing.T) {
	if ParseDecision("please approve running the deploy tool") != DecisionPending {
		t.Fatal("substring match leaked: a sentence containing 'approve' was treated as approval")
	}
}

// Safety asymmetry: deny is liberal (any deny word denies) and wins over an
// embedded approve word; approve stays strict (whole reply only).
func TestParseDecisionIsDenyBiased(t *testing.T) {
	denies := []string{
		"deny, i would never approve this!", // embedded "approve" must not win
		"no",
		"no way",
		"approve, no",      // contradictory -> fail safe to deny
		"absolutely not, reject it",
		"cancel please",
	}
	for _, m := range denies {
		if got := ParseDecision(m); got != DecisionDenied {
			t.Errorf("ParseDecision(%q) = %v, want denied", m, got)
		}
	}
	// A sentence that only CONTAINS "approve" still does not approve.
	if ParseDecision("please approve the deploy") != DecisionPending {
		t.Error("a sentence merely containing 'approve' must stay pending, not approve")
	}
}

func TestPromptMentionsTool(t *testing.T) {
	p := Prompt("deploy-prod")
	if p == "" || !contains(p, "deploy-prod") {
		t.Fatalf("prompt missing tool id: %q", p)
	}
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (func() bool {
		for i := 0; i+len(sub) <= len(s); i++ {
			if s[i:i+len(sub)] == sub {
				return true
			}
		}
		return false
	})()
}
