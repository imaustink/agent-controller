// Package callertools implements the third level of tool calling: tools the
// CONSUMER supplies in the request body (upstream ADR 0035), alongside the
// orchestrator's own Skill-scoped loop (ADR 0008) and a sub-agent's internal
// loop (ADR 0028).
//
// Unlike both of those, these are executed by the caller's own client and
// never by this system. Our only job is to decide one fits, hand back an
// OpenAI-shaped tool_calls, and pick the conversation back up when the client
// resends with the result.
//
// # Trust
//
// Every text field here is UNTRUSTED — supplied per-request by whoever holds a
// bearer token, one level below a Tool CR description (semi-trusted, authored
// by that tool's owner) and two below Skill markdown (trusted). It still has to
// reach the planner's prompt to be selectable, so it is rendered inside a
// distinctly-labelled block and the planner's chosen id is re-validated
// against the resolved list exactly as for catalog tools. A hostile
// description's ceiling is "gets itself selected" — which for a caller tool
// means the caller's own client is asked to run the caller's own function.
package callertools

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// IDPrefix namespaces every caller tool away from the Tool CR catalog, so a
// caller name can never collide with or shadow a real tool id — and the
// planner's re-validation cannot be tricked into resolving one to the other.
const IDPrefix = "caller:"

func ID(name string) string       { return IDPrefix + name }
func IsID(id string) bool         { return strings.HasPrefix(id, IDPrefix) }
func NameFromID(id string) string { return strings.TrimPrefix(id, IDPrefix) }

// Limits. These are abuse ceilings, not tuning knobs, so exceeding one is an
// error rather than a silent truncation that would make the agent look broken.
const (
	// MaxTools is well above what any real client sends — Open WebUI pointed at
	// a populated tool server lands in the 30–80 range.
	MaxTools = 128
	// MaxNameLength is OpenAI's own function-name constraint.
	MaxNameLength = 64
	// MaxDescriptionLength bounds what reaches the planner prompt.
	MaxDescriptionLength = 4096
	// MaxSchemaLength bounds one serialized JSON Schema.
	MaxSchemaLength = 16384
)

var namePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

// Descriptor is one normalized, validated caller function definition.
type Descriptor struct {
	// Name is the function name as the CLIENT knows it. This exact string goes
	// back out in tool_calls[].function.name, so it must never be rewritten.
	Name string `json:"name"`
	// Description is the text that gets embedded.
	Description string `json:"description"`
	// ParametersJSON is the function's JSON Schema, carried verbatim so the
	// planner can produce conforming arguments. Kept already-serialized: this
	// system never interprets it, and canonicalizing once keeps both the
	// content hash and the stored payload stable regardless of key ordering.
	ParametersJSON string `json:"parametersJson"`
	// Hash is sha256 over the normalized definition, and doubles as the
	// store's point id — which is what makes the collection an embedding cache
	// rather than per-turn write amplification.
	Hash string `json:"hash"`
}

// Choice is how the caller constrained selection (OpenAI's tool_choice).
//
// "required" is deliberately not a distinct kind: the planner is our own
// structured-output call and cannot be made to guarantee a tool call, so it
// rides as auto+Required — a strong prompt directive rather than a promise the
// dispatch layer would be lying about.
type Choice struct {
	Kind string `json:"kind"` // auto | none | function
	// Required carries tool_choice: "required" as a directive.
	Required bool `json:"required,omitempty"`
	// Name is set for Kind == "function".
	Name string `json:"name,omitempty"`
}

const (
	ChoiceAuto     = "auto"
	ChoiceNone     = "none"
	ChoiceFunction = "function"
)

// PendingCall is a tool call this system is asking the CALLER to execute.
type PendingCall struct {
	// ID is the correlation id the client echoes back as tool_call_id.
	// Generated here — the client has no say — and matched on the way back in
	// by string equality alone.
	ID   string `json:"id"`
	Name string `json:"name"`
	// Arguments is JSON-encoded, per OpenAI's wire format: a string, not an
	// object.
	Arguments string `json:"arguments"`
}

// PriorCall is a completed caller-executed call, read back off the wire from
// an assistant.tool_calls message plus its matching role:"tool" result.
//
// This is the ONLY way a caller tool's result reaches this system. There is no
// server-side conversation store to read it from, which is why resumption is
// parsed from the request rather than looked up.
type PriorCall struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
	// Result is the role:"tool" message's content, verbatim.
	Result string `json:"result"`
}

// canonicalJSON re-serializes with object keys sorted, recursively, so two
// structurally identical schemas differing only in property order hash the
// same. Without it a client that serializes non-deterministically would miss
// the embedding cache on every single turn — the exact cost the cache exists
// to avoid.
func canonicalJSON(raw json.RawMessage) (string, error) {
	var value any
	if len(raw) == 0 {
		value = map[string]any{"type": "object", "properties": map[string]any{}}
	} else if err := json.Unmarshal(raw, &value); err != nil {
		return "", err
	}
	var b strings.Builder
	if err := writeCanonical(&b, value); err != nil {
		return "", err
	}
	return b.String(), nil
}

func writeCanonical(b *strings.Builder, value any) error {
	switch v := value.(type) {
	case map[string]any:
		keys := make([]string, 0, len(v))
		for k := range v {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		b.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				b.WriteByte(',')
			}
			key, err := json.Marshal(k)
			if err != nil {
				return err
			}
			b.Write(key)
			b.WriteByte(':')
			if err := writeCanonical(b, v[k]); err != nil {
				return err
			}
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, item := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			if err := writeCanonical(b, item); err != nil {
				return err
			}
		}
		b.WriteByte(']')
	default:
		encoded, err := json.Marshal(v)
		if err != nil {
			return err
		}
		b.Write(encoded)
	}
	return nil
}

// New builds a descriptor and computes its hash.
//
// Description and schema are part of the hash deliberately: an EDITED tool
// that keeps its name is a different definition and must not resolve to the
// stale embedding of the old one.
func New(name, description string, parameters json.RawMessage) (Descriptor, error) {
	parametersJSON, err := canonicalJSON(parameters)
	if err != nil {
		return Descriptor{}, err
	}
	sum := sha256.Sum256([]byte(name + description + parametersJSON))
	return Descriptor{
		Name:           name,
		Description:    description,
		ParametersJSON: parametersJSON,
		Hash:           hex.EncodeToString(sum[:]),
	}, nil
}

// Request is the raw tools/tool_choice pair off an incoming body.
type Request struct {
	Tools      []RawTool       `json:"tools"`
	ToolChoice json.RawMessage `json:"tool_choice"`
}

type RawTool struct {
	Type     string      `json:"type"`
	Function RawFunction `json:"function"`
}

type RawFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// Parse validates a request's tools and tool_choice.
//
// Malformed input is REJECTED rather than silently dropped. Silently ignoring
// a caller's tools is the behaviour ADR 0035 exists to fix: a client that
// offers tools and gets prose back has no way to tell whether the agent chose
// not to call them or never saw them.
func Parse(raw Request) ([]Descriptor, Choice, error) {
	choice, err := parseChoice(raw.ToolChoice)
	if err != nil {
		return nil, Choice{}, err
	}
	if len(raw.Tools) == 0 {
		return nil, choice, nil
	}
	if len(raw.Tools) > MaxTools {
		return nil, Choice{}, fmt.Errorf("tools may contain at most %d entries (received %d)", MaxTools, len(raw.Tools))
	}

	tools := make([]Descriptor, 0, len(raw.Tools))
	seen := make(map[string]bool, len(raw.Tools))
	for i, entry := range raw.Tools {
		// Only type "function" exists in the tools array today. An unknown type
		// is rejected rather than skipped: skipping would leave the caller
		// believing a tool is on offer when it is not.
		if entry.Type != "" && entry.Type != "function" {
			return nil, Choice{}, fmt.Errorf("tools[%d].type must be \"function\"", i)
		}
		fn := entry.Function
		if fn.Name == "" {
			return nil, Choice{}, fmt.Errorf("tools[%d].function.name must be a non-empty string", i)
		}
		if len(fn.Name) > MaxNameLength || !namePattern.MatchString(fn.Name) {
			return nil, Choice{}, fmt.Errorf("tools[%d].function.name must match [a-zA-Z0-9_-]{1,%d} (received %q)", i, MaxNameLength, fn.Name)
		}
		// A duplicate name makes the round trip ambiguous: the client matches
		// our tool_calls[].function.name back to one of its own functions, and
		// there would be no answer to which one.
		if seen[fn.Name] {
			return nil, Choice{}, fmt.Errorf("tools contains duplicate function name %q", fn.Name)
		}
		seen[fn.Name] = true

		if len(fn.Description) > MaxDescriptionLength {
			return nil, Choice{}, fmt.Errorf("tools[%d].function.description exceeds %d characters", i, MaxDescriptionLength)
		}
		tool, err := New(fn.Name, fn.Description, fn.Parameters)
		if err != nil {
			return nil, Choice{}, fmt.Errorf("tools[%d].function.parameters must be a JSON Schema object", i)
		}
		if len(tool.ParametersJSON) > MaxSchemaLength {
			return nil, Choice{}, fmt.Errorf("tools[%d].function.parameters exceeds %d serialized characters", i, MaxSchemaLength)
		}
		tools = append(tools, tool)
	}

	// A named tool_choice must actually be on offer, or the caller has asked
	// for something that cannot happen and would get a silently ordinary
	// answer instead.
	if choice.Kind == ChoiceFunction && !seen[choice.Name] {
		return nil, Choice{}, fmt.Errorf("tool_choice names %q, which is not present in tools", choice.Name)
	}
	return tools, choice, nil
}

func parseChoice(raw json.RawMessage) (Choice, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return Choice{Kind: ChoiceAuto}, nil
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		switch asString {
		case "auto":
			return Choice{Kind: ChoiceAuto}, nil
		case "none":
			return Choice{Kind: ChoiceNone}, nil
		case "required":
			return Choice{Kind: ChoiceAuto, Required: true}, nil
		default:
			return Choice{}, fmt.Errorf(`tool_choice must be "auto", "none", "required", or a {type:"function"} object`)
		}
	}

	var asObject struct {
		Type     string `json:"type"`
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if err := json.Unmarshal(raw, &asObject); err != nil {
		return Choice{}, fmt.Errorf("tool_choice must be a string or an object")
	}
	if asObject.Type != "function" {
		return Choice{}, fmt.Errorf(`tool_choice object must be of the form {type:"function",function:{name}}`)
	}
	if asObject.Function.Name == "" {
		return Choice{}, fmt.Errorf("tool_choice.function.name must be a non-empty string")
	}
	return Choice{Kind: ChoiceFunction, Name: asObject.Function.Name}, nil
}

// Hashes returns the descriptors' hashes, in order.
func Hashes(tools []Descriptor) []string {
	out := make([]string, len(tools))
	for i, t := range tools {
		out[i] = t.Hash
	}
	return out
}
