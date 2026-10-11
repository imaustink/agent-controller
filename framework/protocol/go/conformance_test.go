// Runs the shared wire-contract fixtures (../conformance/*.json) against the
// generated Go types + protovalidate. See ../conformance/README.md for the
// fixture format and what each check proves.
package conformance_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"buf.build/go/protovalidate"
	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"

	protocolv1 "github.com/imaustink/agent-controller/framework/protocol/go/agentcontroller/protocol/v1"
)

const impl = "proto-go"

var knownImpls = map[string]bool{"proto-ts": true, "proto-go": true, "zod": true}

var schemas = map[string]func() proto.Message{
	"agentcontroller.protocol.v1.Event":            func() proto.Message { return &protocolv1.Event{} },
	"agentcontroller.protocol.v1.TurnEvent":        func() proto.Message { return &protocolv1.TurnEvent{} },
	"agentcontroller.protocol.v1.AgentUpMessage":   func() proto.Message { return &protocolv1.AgentUpMessage{} },
	"agentcontroller.protocol.v1.AgentDownMessage": func() proto.Message { return &protocolv1.AgentDownMessage{} },
}

type fixtureCase struct {
	Name        string            `json:"name"`
	Valid       bool              `json:"valid"`
	JSON        json.RawMessage   `json:"json"`
	RoundTrip   *bool             `json:"roundTrip"`
	Divergences map[string]string `json:"divergences"`
}

type fixture struct {
	Message string        `json:"message"`
	Cases   []fixtureCase `json:"cases"`
}

func decode(validator protovalidate.Validator, newMsg func() proto.Message, raw []byte) (proto.Message, error) {
	msg := newMsg()
	if err := (protojson.UnmarshalOptions{DiscardUnknown: true}).Unmarshal(raw, msg); err != nil {
		return nil, err
	}
	if err := validator.Validate(msg); err != nil {
		return nil, err
	}
	return msg, nil
}

// normalize compares objects ignoring key order; an empty array equals an
// absent key.
func normalize(v any) any {
	switch t := v.(type) {
	case map[string]any:
		out := map[string]any{}
		for k, val := range t {
			if arr, ok := val.([]any); ok && len(arr) == 0 {
				continue
			}
			out[k] = normalize(val)
		}
		return out
	case []any:
		out := make([]any, len(t))
		for i, val := range t {
			out[i] = normalize(val)
		}
		return out
	default:
		return v
	}
}

func TestConformance(t *testing.T) {
	validator, err := protovalidate.New()
	if err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob(filepath.Join("..", "conformance", "*.json"))
	if err != nil || len(files) == 0 {
		t.Fatalf("no fixtures found (%v)", err)
	}

	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var fx fixture
		if err := json.Unmarshal(raw, &fx); err != nil {
			t.Fatalf("%s: %v", file, err)
		}
		newMsg, ok := schemas[fx.Message]
		if !ok {
			t.Fatalf("%s names unknown message %q", file, fx.Message)
		}

		t.Run(filepath.Base(file), func(t *testing.T) {
			seen := map[string]bool{}
			for _, c := range fx.Cases {
				if seen[c.Name] {
					t.Errorf("duplicate case name %q", c.Name)
				}
				seen[c.Name] = true
				for k := range c.Divergences {
					if !knownImpls[k] {
						t.Errorf("%q lists unknown implementation %q", c.Name, k)
					}
				}

				_, diverges := c.Divergences[impl]
				t.Run(strings.ReplaceAll(c.Name, " ", "_"), func(t *testing.T) {
					msg, err := decode(validator, newMsg, c.JSON)
					want := c.Valid != diverges
					if got := err == nil; got != want {
						t.Fatalf("accepted=%v, want %v (err: %v)", got, want, err)
					}
					if err != nil || !c.Valid || diverges || (c.RoundTrip != nil && !*c.RoundTrip) {
						return
					}
					out, err := protojson.Marshal(msg)
					if err != nil {
						t.Fatal(err)
					}
					var gotJSON, wantJSON any
					_ = json.Unmarshal(out, &gotJSON)
					_ = json.Unmarshal(c.JSON, &wantJSON)
					if !reflect.DeepEqual(normalize(gotJSON), normalize(wantJSON)) {
						t.Errorf("round trip changed the wire shape:\n got: %s\nwant: %s", out, c.JSON)
					}
				})
			}
		})
	}
}
