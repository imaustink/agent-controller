package callertools_test

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/callertools"
)

func req(tools string, choice string) callertools.Request {
	var r callertools.Request
	if tools != "" {
		if err := json.Unmarshal([]byte(tools), &r.Tools); err != nil {
			panic(err)
		}
	}
	if choice != "" {
		r.ToolChoice = json.RawMessage(choice)
	}
	return r
}

const searchTool = `[{"type":"function","function":{
	"name":"web_search",
	"description":"Search the web",
	"parameters":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}
}}]`

func TestParseAcceptsAStandardToolArray(t *testing.T) {
	tools, choice, err := callertools.Parse(req(searchTool, ""))
	require.NoError(t, err)
	require.Len(t, tools, 1)
	require.Equal(t, "web_search", tools[0].Name)
	require.Equal(t, "Search the web", tools[0].Description)
	require.Contains(t, tools[0].ParametersJSON, `"query"`)
	require.Len(t, tools[0].Hash, 64)
	require.Equal(t, callertools.ChoiceAuto, choice.Kind)
	require.False(t, choice.Required)
}

func TestParseNoToolsIsIndistinguishableFromBefore(t *testing.T) {
	tools, choice, err := callertools.Parse(callertools.Request{})
	require.NoError(t, err)
	require.Empty(t, tools)
	require.Equal(t, callertools.ChoiceAuto, choice.Kind)
}

// The cache is only free if a client that serializes its schema
// non-deterministically still hits it. Without canonicalization every turn
// would re-embed every tool — the exact cost the content-hash key exists to
// avoid.
func TestHashIsStableAcrossSchemaKeyOrder(t *testing.T) {
	a, err := callertools.New("t", "d", json.RawMessage(`{"type":"object","properties":{"b":{"type":"string"},"a":{"type":"number"}}}`))
	require.NoError(t, err)
	b, err := callertools.New("t", "d", json.RawMessage(`{"properties":{"a":{"type":"number"},"b":{"type":"string"}},"type":"object"}`))
	require.NoError(t, err)
	require.Equal(t, a.Hash, b.Hash)
	require.Equal(t, a.ParametersJSON, b.ParametersJSON)
}

// An EDITED tool that keeps its name is a different definition and must not
// resolve to the stale embedding of the old one.
func TestHashCoversDescriptionAndSchemaNotJustName(t *testing.T) {
	base, err := callertools.New("t", "does one thing", json.RawMessage(`{"type":"object"}`))
	require.NoError(t, err)
	reworded, err := callertools.New("t", "does another thing", json.RawMessage(`{"type":"object"}`))
	require.NoError(t, err)
	reschemaed, err := callertools.New("t", "does one thing", json.RawMessage(`{"type":"object","properties":{"x":{}}}`))
	require.NoError(t, err)

	require.NotEqual(t, base.Hash, reworded.Hash)
	require.NotEqual(t, base.Hash, reschemaed.Hash)
}

// Malformed input is REJECTED, never silently dropped: a client that offers
// tools and gets prose back cannot tell whether the agent declined to call them
// or never saw them.
func TestParseRejectsRatherThanSilentlyDropping(t *testing.T) {
	cases := []struct{ name, tools, choice, want string }{
		{"unknown type", `[{"type":"retrieval","function":{"name":"x"}}]`, "", `must be "function"`},
		{"missing name", `[{"type":"function","function":{"description":"d"}}]`, "", "non-empty string"},
		{"illegal name", `[{"type":"function","function":{"name":"has spaces"}}]`, "", "must match"},
		{"duplicate name", `[{"function":{"name":"x"}},{"function":{"name":"x"}}]`, "", "duplicate"},
		{"bad tool_choice string", `[{"function":{"name":"x"}}]`, `"whenever"`, `must be "auto"`},
		{"bad tool_choice object", `[{"function":{"name":"x"}}]`, `{"type":"retrieval"}`, "must be of the form"},
		{"tool_choice names an absent tool", `[{"function":{"name":"x"}}]`, `{"type":"function","function":{"name":"y"}}`, "not present in tools"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, _, err := callertools.Parse(req(c.tools, c.choice))
			require.ErrorContains(t, err, c.want)
		})
	}
}

func TestParseEnforcesCaps(t *testing.T) {
	t.Run("tool count", func(t *testing.T) {
		tools := make([]callertools.RawTool, callertools.MaxTools+1)
		for i := range tools {
			tools[i].Type = "function"
			tools[i].Function.Name = "t" + string(rune('a'+i%26)) + string(rune('a'+i/26))
		}
		_, _, err := callertools.Parse(callertools.Request{Tools: tools})
		require.ErrorContains(t, err, "at most")
	})

	t.Run("description length", func(t *testing.T) {
		long := make([]byte, callertools.MaxDescriptionLength+1)
		for i := range long {
			long[i] = 'x'
		}
		_, _, err := callertools.Parse(callertools.Request{Tools: []callertools.RawTool{{
			Type:     "function",
			Function: callertools.RawFunction{Name: "t", Description: string(long)},
		}}})
		require.ErrorContains(t, err, "exceeds")
	})
}

func TestParseToolChoiceForms(t *testing.T) {
	_, choice, err := callertools.Parse(req(searchTool, `"none"`))
	require.NoError(t, err)
	require.Equal(t, callertools.ChoiceNone, choice.Kind)

	// "required" is a directive, not a guarantee: it rides as auto+Required
	// because the planner is our own structured-output call and may still
	// legitimately conclude nothing fits.
	_, choice, err = callertools.Parse(req(searchTool, `"required"`))
	require.NoError(t, err)
	require.Equal(t, callertools.ChoiceAuto, choice.Kind)
	require.True(t, choice.Required)

	_, choice, err = callertools.Parse(req(searchTool, `{"type":"function","function":{"name":"web_search"}}`))
	require.NoError(t, err)
	require.Equal(t, callertools.ChoiceFunction, choice.Kind)
	require.Equal(t, "web_search", choice.Name)
}

// Namespacing is what stops a caller name colliding with, or shadowing, a Tool
// CR id — and what keeps the planner's re-validation from resolving one to the
// other.
func TestIDNamespacing(t *testing.T) {
	require.Equal(t, "caller:web_search", callertools.ID("web_search"))
	require.True(t, callertools.IsID("caller:web_search"))
	require.False(t, callertools.IsID("kubectl-readonly"))
	require.Equal(t, "web_search", callertools.NameFromID("caller:web_search"))
}
