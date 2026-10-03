// Package continuation ports agent-controller's per-tool continuation
// tokens (ADR 0016/0017): a tool prefixes its success output with an opaque
// `<!-- continuation: <token> -->` marker carrying its own resumable state
// (repo/branch/PR, a Mealie slug, …). The orchestrator strips the marker
// before the result reaches the transcript/LLM — state never rides through
// chat, closing the prompt-injection surface — stores the token in durable
// workflow state, and re-injects it into the SAME tool's next invocation.
// The token content is never parsed here.
package continuation

import (
	"regexp"
	"strings"
)

var markerRe = regexp.MustCompile(`(?i)^<!--\s*continuation:\s*([\s\S]*?)\s*-->\r?\n*`)

// Extract strips a leading continuation marker. Without one, token is ""
// and text returns unchanged.
func Extract(text string) (token, rest string) {
	m := markerRe.FindStringSubmatch(text)
	if m == nil {
		return "", text
	}
	return m[1], text[len(m[0]):]
}

// Prepend produces the tool input for a follow-up call: marker + original.
func Prepend(token, text string) string {
	return "<!-- continuation: " + token + " -->\n\n" + text
}

// ResolveKey resolves the state key a tool's continuation token is stored under
// (ADR 0017), WITHOUT depending on the model to re-supply an instance id each
// turn.
//
// The instance scope (`toolID::instanceKey`) exists so two instances of a
// multi-instance tool in one conversation — two recipes being published, say —
// don't clobber each other's state. The id that distinguished them used to be a
// URL the planner copied verbatim into tool_instance_key on EVERY call; a core
// continuity behaviour then rode on the model re-extracting it, and a refine turn
// where it didn't lost the publish target. This derives the key from SERVER-SIDE
// state instead:
//
//   - An explicit instanceKey (the planner naming a specific instance, e.g.
//     switching recipes) always wins.
//   - Otherwise, when state already holds exactly ONE continuation entry for this
//     tool, reuse THAT key: the active instance is recovered from state, so a
//     refine turn continues the same target with no model input.
//   - Otherwise fall back to the bare tool id (first call, or ambiguous).
//
// PARITY: resolveContinuationKey in apps/agent-orchestrator/src/continuation.ts.
func ResolveKey(toolID, instanceKey string, existing map[string]string) string {
	if instanceKey != "" {
		return toolID + "::" + instanceKey
	}
	prefix := toolID + "::"
	var own []string
	for k := range existing {
		if k == toolID || strings.HasPrefix(k, prefix) {
			own = append(own, k)
		}
	}
	// Exactly one active instance: recover it from state. More than one is
	// genuinely ambiguous without the planner naming which, so fall back rather
	// than risk writing one recipe's edit onto another.
	if len(own) == 1 {
		return own[0]
	}
	return toolID
}
