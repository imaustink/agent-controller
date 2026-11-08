// Package approval implements the declarative tool-approval policy (ADR 0003):
// deterministic, single-owner control flow that decides whether a human must
// approve a tool call before it executes. No LLM participates in the decision
// (the optional "auto" evaluator is a deferred phase); the policy is data on the
// Tool/Agent CRs, resolved here and enforced at the tool-dispatch choke point.
//
// This mirrors the TypeScript engine's policy so both engines behave identically
// against the same CRs.
package approval

import (
	"strings"
	"unicode"
)

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
	// DecisionTimeout is never returned by ParseDecision; a caller that bounds the
	// human wait with a timer returns it when the timer fires, so the gate can
	// surface a distinct "approval_timeout" failure (fail safe, like a denial).
	DecisionTimeout
)

var approveWords = map[string]bool{
	"approve": true, "approved": true, "yes": true, "y": true, "ok": true,
	"okay": true, "allow": true, "allowed": true, "confirm": true, "confirmed": true,
}

var denyWords = map[string]bool{
	"deny": true, "denied": true, "no": true, "n": true, "reject": true,
	"rejected": true, "cancel": true, "cancelled": true, "stop": true, "disallow": true,
}

// ParseDecision interprets a user's reply deterministically, with a deliberate
// safety asymmetry: it is STRICT about approving and LIBERAL about denying, so
// the gate fails toward NOT running a tool.
//
//   - Deny is checked FIRST and matches if ANY word in the reply is a deny word,
//     so "deny, i would never approve this!" denies rather than being confused by
//     the embedded "approve", and "approve, no" denies too.
//   - Approve matches ONLY when the whole reply is a single approve word, so a
//     sentence that merely contains "approve" ("please approve the deploy") never
//     runs the tool — it is pending and re-asked.
//
// Anything that is neither is DecisionPending; the gate never executes on an
// ambiguous answer.
func ParseDecision(message string) Decision {
	m := strings.ToLower(strings.TrimSpace(message))
	// Strip a single trailing punctuation mark so "approve." / "yes!" still count.
	m = strings.TrimRight(m, ".!,")

	// Deny first, token-wise: any deny word anywhere in the reply denies.
	for _, tok := range strings.FieldsFunc(m, func(r rune) bool { return !unicode.IsLetter(r) }) {
		if denyWords[tok] {
			return DecisionDenied
		}
	}
	// Approve strictly: only a bare approve word (the whole reply) approves.
	if approveWords[m] {
		return DecisionApproved
	}
	return DecisionPending
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

// Timed-out result envelope, surfaced when a human did not answer in time. Kept
// distinct from a denial so telemetry and the model can tell "the user said no"
// from "nobody answered."
const (
	TimeoutCode    = "approval_timeout"
	TimeoutMessage = "Tool call was not approved in time and was not run."
)

func normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}
