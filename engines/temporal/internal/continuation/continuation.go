// Package continuation ports agent-controller's per-tool continuation
// tokens (ADR 0016/0017): a tool prefixes its success output with an opaque
// `<!-- continuation: <token> -->` marker carrying its own resumable state
// (repo/branch/PR, a Mealie slug, …). The orchestrator strips the marker
// before the result reaches the transcript/LLM — state never rides through
// chat, closing the prompt-injection surface — stores the token in durable
// workflow state, and re-injects it into the SAME tool's next invocation.
// The token content is never parsed here.
package continuation

import "regexp"

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
