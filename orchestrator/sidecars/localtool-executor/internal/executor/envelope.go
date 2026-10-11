package executor

import (
	"bytes"
	"encoding/json"
)

// extractEnvelope pulls the tool's final stdio-ABI envelope out of its stdout.
// Returns ok=false when nothing usable is found. The ABI says a tool writes
// exactly one final JSON envelope; to be tolerant of tools that also print
// diagnostic lines, this tries the whole trimmed output first, then scans
// backward for the last line that parses as an envelope with a recognized
// "type".
func extractEnvelope(stdout []byte) (Envelope, bool) {
	if env, ok := parseEnvelope(bytes.TrimSpace(stdout)); ok {
		return env, true
	}
	lines := bytes.Split(stdout, []byte("\n"))
	for i := len(lines) - 1; i >= 0; i-- {
		line := bytes.TrimSpace(lines[i])
		if len(line) == 0 {
			continue
		}
		if env, ok := parseEnvelope(line); ok {
			return env, true
		}
	}
	return Envelope{}, false
}

// extractEnvelopeOrFail is extractEnvelope with a failed-envelope fallback, so a
// misbehaving tool still yields a structured result rather than an error.
func extractEnvelopeOrFail(stdout []byte) Envelope {
	if env, ok := extractEnvelope(stdout); ok {
		return env
	}
	return failedEnvelope("bad_output", "tool did not emit a valid stdout envelope")
}

func parseEnvelope(data []byte) (Envelope, bool) {
	if len(data) == 0 || data[0] != '{' {
		return Envelope{}, false
	}
	var env Envelope
	if err := json.Unmarshal(data, &env); err != nil {
		return Envelope{}, false
	}
	if env.Type != "succeeded" && env.Type != "failed" {
		return Envelope{}, false
	}
	return env, true
}
