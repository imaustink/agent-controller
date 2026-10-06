// Package approval implements the declarative tool-approval policy (ADR 0003):
// deterministic, single-owner control flow that decides whether a human must
// approve a tool call before it executes. No LLM participates in the decision
// (the optional "auto" evaluator is a deferred phase); the policy is data on the
// Tool/Agent CRs, resolved here and enforced at the tool-dispatch choke point.
//
// This mirrors the TypeScript engine's policy so both engines behave identically
// against the same CRs.
package approval

import "strings"

// Policy values, matching the CRD enum (core-controller api/v1alpha1).
const (
	// PolicyNever runs the tool silently. The empty string resolves to this, so
	// existing CRs are unaffected.
	PolicyNever = "never"
	// PolicyAlways pauses the turn and asks the user to approve or deny.
	PolicyAlways = "always"
	// PolicyAuto consults an optional evaluator and escalates to a human when
	// unsure. Deferred (ADR 0003 A3): until an evaluator is configured it behaves
	// as PolicyAlways — fail safe, never silently auto-approve.
	PolicyAuto = "auto"
)

// Resolve applies most-specific-wins: a tool's own policy, else the governing
// agent's default, else "never". Empty strings always collapse to "never".
func Resolve(toolApproval, agentDefault string) string {
	p := normalize(toolApproval)
	if p == "" {
		p = normalize(agentDefault)
	}
	if p == "" {
		return PolicyNever
	}
	return p
}

// RequiresHuman reports whether a resolved policy must pause for human approval.
// "auto" requires a human until an evaluator exists (see PolicyAuto).
func RequiresHuman(policy string) bool {
	switch normalize(policy) {
	case PolicyAlways, PolicyAuto:
		return true
	default:
		return false
	}
}

// Decision is the parsed outcome of a user's reply to an approval prompt.
type Decision int

const (
	// DecisionPending means the reply did not clearly approve or deny; the caller
	// should re-ask rather than guess (fail safe).
	DecisionPending Decision = iota
	DecisionApproved
	DecisionDenied
)

var approveWords = map[string]bool{
	"approve": true, "approved": true, "yes": true, "y": true, "ok": true,
	"okay": true, "allow": true, "allowed": true, "confirm": true, "confirmed": true,
}

var denyWords = map[string]bool{
	"deny": true, "denied": true, "no": true, "n": true, "reject": true,
	"rejected": true, "cancel": true, "cancelled": true, "stop": true, "disallow": true,
}

// ParseDecision interprets a user's reply deterministically. Anything that is
// not an unambiguous approve or deny is DecisionPending — the gate never
// executes a tool on an ambiguous answer.
func ParseDecision(message string) Decision {
	m := strings.ToLower(strings.TrimSpace(message))
	// Strip a single trailing punctuation mark so "approve." / "yes!" still count.
	m = strings.TrimRight(m, ".!,")
	switch {
	case approveWords[m]:
		return DecisionApproved
	case denyWords[m]:
		return DecisionDenied
	default:
		return DecisionPending
	}
}

// Prompt is the shared approval wording. Both engines use this exact text so a
// client cannot tell them apart.
func Prompt(toolID string) string {
	return "Approval required: run tool \"" + toolID + "\"? Reply \"approve\" or \"deny\"."
}

// Denied result envelope, surfaced to the planner as a failed tool call.
const (
	DeniedCode    = "approval_denied"
	DeniedMessage = "Tool call was denied by the user."
)

func normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
