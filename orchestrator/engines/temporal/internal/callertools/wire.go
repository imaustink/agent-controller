package callertools

import (
	"encoding/json"
	"strings"
)

// WireMessage is the subset of an OpenAI chat message this package reads.
type WireMessage struct {
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	ToolCalls []WireToolCall  `json:"tool_calls,omitempty"`
	// ToolCallID correlates a role:"tool" result back to the call that asked
	// for it.
	ToolCallID string `json:"tool_call_id,omitempty"`
}

type WireToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string          `json:"name"`
		Arguments json.RawMessage `json:"arguments"`
	} `json:"function"`
}

// CollectPriorCalls lifts the calls the client already executed for the
// exchange in flight out of the messages array, pairing each with its result.
//
// Two properties of this parsing matter. Prior tool results were previously
// dropped entirely — the facade only ever kept user/assistant messages — so
// without this a client's tool result would vanish and the planner would
// re-issue the same call forever. And an assistant message carrying ONLY
// tool_calls has content: null, which history folding skips; lifting the
// call/result pair into structured history is what keeps the planner reading
// it as a tool result rather than as conversation prose.
//
// Only messages AFTER the last user turn are considered: those are the ones
// belonging to the exchange being resumed.
func CollectPriorCalls(messages []WireMessage, lastUserIndex int) []PriorCall {
	requested := map[string]PendingCall{}
	for i := lastUserIndex + 1; i < len(messages); i++ {
		m := messages[i]
		if m.Role != "assistant" {
			continue
		}
		for _, call := range m.ToolCalls {
			if call.ID == "" || call.Function.Name == "" {
				continue
			}
			requested[call.ID] = PendingCall{
				ID:        call.ID,
				Name:      call.Function.Name,
				Arguments: argumentsString(call.Function.Arguments),
			}
		}
	}
	if len(requested) == 0 {
		return nil
	}

	var calls []PriorCall
	for i := lastUserIndex + 1; i < len(messages); i++ {
		m := messages[i]
		if m.Role != "tool" || m.ToolCallID == "" {
			continue
		}
		// An unmatched result is skipped rather than guessed at: with no paired
		// call there is no tool name to attribute it to, so it would enter the
		// planner's history as an orphan blob.
		req, ok := requested[m.ToolCallID]
		if !ok {
			continue
		}
		calls = append(calls, PriorCall{
			ID:        m.ToolCallID,
			Name:      req.Name,
			Arguments: req.Arguments,
			Result:    contentString(m.Content),
		})
	}
	return calls
}

// argumentsString keeps OpenAI's wire shape: arguments are a JSON-encoded
// string. A client that sends an object instead is accommodated by
// re-encoding, since rejecting a turn over it would lose a completed call.
func argumentsString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return "{}"
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	return string(raw)
}

func contentString(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	return string(raw)
}

// internalTaskPrefix marks Open WebUI's own housekeeping completions — chat
// title, tags, search query, follow-up suggestions — which arrive at the same
// endpoint as real turns.
const internalTaskPrefix = "### Task:"

// IsInternalUITask reports whether a request is a chat UI's own housekeeping
// rather than a user turn.
//
// Load-bearing for caller tools specifically, and covered by a test: a
// title-generation request that happens to carry the client's tool array must
// return prose, never a tool call the client would then execute as a side
// effect of rendering a chat title. It matters more broadly too — such a
// request's embedded history can resemble anything, and routing it through
// delegation could launch a real privileged agent run for what should be a
// cheap, side-effect-free completion.
func IsInternalUITask(userContent string) bool {
	return strings.HasPrefix(strings.TrimLeft(userContent, " \t\r\n"), internalTaskPrefix)
}
