package catalog_test

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
)

// The shared cross-engine CEL-parity suite (docs/event-triggers.md §3–§4).
// The SAME file runs in @controller-agent/event-triggers' tests against the
// JS evaluator; both engines must produce every listed verdict/value, or one
// of them disagrees with the contract.

type typedValue struct {
	Value json.RawMessage `json:"value"`
	Type  string          `json:"type"`
}

type parityFixture struct {
	Envelopes map[string]catalog.Envelope `json:"envelopes"`
	Cases     []struct {
		Name     string `json:"name"`
		Envelope string `json:"envelope"`
		Expr     string `json:"expr"`
		Expect   struct {
			Value json.RawMessage `json:"value"`
			Type  string          `json:"type"`
			Error bool            `json:"error"`
		} `json:"expect"`
	} `json:"cases"`
	Templates []struct {
		Name     string                `json:"name"`
		Template string                `json:"template"`
		Params   map[string]typedValue `json:"params"`
		Expect   string                `json:"expect"`
	} `json:"templates"`
	Matching []struct {
		Name            string            `json:"name"`
		Envelope        string            `json:"envelope"`
		CallerSessionID string            `json:"callerSessionId"`
		Triggers        []json.RawMessage `json:"triggers"`
		Expect          struct {
			Trigger      *string               `json:"trigger"`
			Error        bool                  `json:"error"`
			Params       map[string]typedValue `json:"params"`
			StringParams map[string]string     `json:"stringParams"`
			SessionID    string                `json:"sessionId"`
			Prompt       *string               `json:"prompt"`
			Reply        json.RawMessage       `json:"reply"`
			ToolInput    *string               `json:"toolInput"`
		} `json:"expect"`
	} `json:"matching"`
}

// fixturePath resolves the fixture from THIS file's location, so the test
// finds it whatever directory `go test` is run from.
func fixturePath(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	require.True(t, ok)
	// engines/temporal/internal/catalog -> repository root.
	return filepath.Join(filepath.Dir(file), "..", "..", "..", "..",
		"packages", "event-triggers", "fixtures", "cel-parity.json")
}

func loadParityFixture(t *testing.T) parityFixture {
	t.Helper()
	raw, err := os.ReadFile(fixturePath(t))
	require.NoError(t, err, "the shared CEL-parity fixture must be present")
	var f parityFixture
	require.NoError(t, json.Unmarshal(raw, &f))
	// A fixture that silently decoded to nothing would make every loop below
	// vacuous — a parity suite that can no longer fail.
	require.NotEmpty(t, f.Envelopes)
	require.NotEmpty(t, f.Cases)
	require.NotEmpty(t, f.Templates)
	require.NotEmpty(t, f.Matching)
	return f
}

// canonicalJSON re-encodes through a generic value, so key order and number
// spelling (42 vs 42.0, int64 vs float64) cannot make equal values differ.
func canonicalJSON(t *testing.T, v any) string {
	t.Helper()
	raw, err := json.Marshal(v)
	require.NoError(t, err)
	var generic any
	require.NoError(t, json.Unmarshal(raw, &generic))
	out, err := json.Marshal(generic)
	require.NoError(t, err)
	return string(out)
}

func rawCanonical(t *testing.T, raw json.RawMessage) string {
	t.Helper()
	var generic any
	require.NoError(t, json.Unmarshal(raw, &generic))
	return canonicalJSON(t, generic)
}

// typedNative builds the Go value a fixture's {value, type} pair denotes. JSON
// cannot say int vs double, so the declared type decides.
func typedNative(t *testing.T, tv typedValue) any {
	t.Helper()
	var generic any
	require.NoError(t, json.Unmarshal(tv.Value, &generic))
	switch tv.Type {
	case "int":
		f, ok := generic.(float64)
		require.True(t, ok, "int fixture value must be a number")
		return int64(f)
	case "double":
		f, ok := generic.(float64)
		require.True(t, ok, "double fixture value must be a number")
		return f
	default:
		return catalog.NormalizeJSONNumbers(generic)
	}
}

// requireTyped asserts value AND type — the type half is what pins
// int-vs-double, which JSON comparison alone cannot see.
func requireTyped(t *testing.T, want typedValue, got any, msgAndArgs ...any) {
	t.Helper()
	require.Equal(t, rawCanonical(t, want.Value), canonicalJSON(t, got), msgAndArgs...)
	if want.Type != "" {
		require.Equal(t, want.Type, catalog.ValueType(got), msgAndArgs...)
	}
}

func TestCELParityCases(t *testing.T) {
	f := loadParityFixture(t)
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			env, ok := f.Envelopes[c.Envelope]
			require.True(t, ok, "unknown envelope %q", c.Envelope)

			got, err := catalog.EvalEventExpr(c.Expr, env)
			if c.Expect.Error {
				require.Error(t, err, "expected an evaluation error, got %v (%s)", got, catalog.ValueType(got))
				return
			}
			require.NoError(t, err)
			requireTyped(t, typedValue{Value: c.Expect.Value, Type: c.Expect.Type}, got)
		})
	}
}

func TestCELParityTemplates(t *testing.T) {
	f := loadParityFixture(t)
	for _, c := range f.Templates {
		t.Run(c.Name, func(t *testing.T) {
			params := map[string]any{}
			for name, tv := range c.Params {
				params[name] = typedNative(t, tv)
			}
			got, err := catalog.RenderEventTemplate(c.Template, params)
			require.NoError(t, err)
			require.Equal(t, c.Expect, got)
		})
	}
}

func TestCELParityMatching(t *testing.T) {
	f := loadParityFixture(t)
	for _, c := range f.Matching {
		t.Run(c.Name, func(t *testing.T) {
			env, ok := f.Envelopes[c.Envelope]
			require.True(t, ok, "unknown envelope %q", c.Envelope)

			triggers := make([]*catalog.EventTriggerDescriptor, 0, len(c.Triggers))
			for _, raw := range c.Triggers {
				var named struct {
					Name string `json:"name"`
				}
				require.NoError(t, json.Unmarshal(raw, &named))
				var spec catalog.EventTriggerSpec
				require.NoError(t, json.Unmarshal(raw, &spec))
				// Fixture triggers have no status; they stand for triggers
				// core-controller has reconciled Ready.
				triggers = append(triggers, catalog.NewEventTriggerDescriptor(named.Name, spec, true))
			}

			m, err := catalog.MatchEventTriggers(triggers, env, c.CallerSessionID)
			if c.Expect.Error {
				var matchErr *catalog.MatchError
				require.True(t, errors.As(err, &matchErr), "expected a match failure, got match=%v err=%v", m, err)
				return
			}
			require.NoError(t, err)
			if c.Expect.Trigger == nil {
				require.Nil(t, m, "expected no trigger to match")
				return
			}
			require.NotNil(t, m, "expected %s to match", *c.Expect.Trigger)
			require.Equal(t, *c.Expect.Trigger, m.Trigger.Name)

			// Fields absent from expect are not asserted (the fixture's own
			// contract); present ones are asserted exactly.
			if c.Expect.Params != nil {
				require.Len(t, m.Params, len(c.Expect.Params))
				for name, want := range c.Expect.Params {
					got, ok := m.Params[name]
					require.True(t, ok, "missing param %q", name)
					requireTyped(t, want, got, "param %q", name)
				}
			}
			if c.Expect.StringParams != nil {
				require.Equal(t, c.Expect.StringParams, m.StringParams)
			}
			if c.Expect.SessionID != "" {
				require.Equal(t, c.Expect.SessionID, m.SessionID)
			}
			if c.Expect.Prompt != nil {
				require.Equal(t, *c.Expect.Prompt, m.Prompt)
			}
			if c.Expect.ToolInput != nil {
				require.Equal(t, *c.Expect.ToolInput, m.ToolInput)
			}

			switch {
			case len(c.Expect.Reply) == 0:
				// absent: not asserted
			case string(c.Expect.Reply) == "null":
				require.Nil(t, m.Reply)
			default:
				require.NotNil(t, m.Reply)
				require.Equal(t, rawCanonical(t, c.Expect.Reply), canonicalJSON(t, m.Reply))
			}
		})
	}
}

// The comparisons above must be able to fail: an int where a double was
// expected, or a different value, has to be caught — otherwise the suite
// reads as parity coverage while asserting nothing.
func TestCELParityComparisonsCanFail(t *testing.T) {
	wantInt := typedValue{Value: json.RawMessage(`42`), Type: "int"}
	require.Equal(t, "int", catalog.ValueType(int64(42)))
	require.NotEqual(t, wantInt.Type, catalog.ValueType(float64(42)), "a double 42 must not pass as an int")
	require.NotEqual(t, rawCanonical(t, wantInt.Value), canonicalJSON(t, int64(43)))
	require.NotEqual(t, rawCanonical(t, json.RawMessage(`{"a":1}`)), canonicalJSON(t, map[string]any{"a": int64(2)}))
}
