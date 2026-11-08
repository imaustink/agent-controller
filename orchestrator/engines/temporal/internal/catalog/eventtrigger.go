package catalog

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/google/cel-go/cel"
	"github.com/google/cel-go/common/types"
	"github.com/google/cel-go/common/types/ref"
	"github.com/google/cel-go/common/types/traits"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// EventTrigger lives in this package because it is decoded from the same API
// group as the rest of the catalog, but it is deliberately NOT part of
// Indexer: a trigger is selected by evaluating a CEL predicate against an
// event, never retrieved by similarity, so embedding it would cost a vector
// round trip to answer a predicate — and would put a dispatch table into the
// candidate set the skill/tool catalogs' own recall depends on. The registry
// that holds triggers is a plain in-memory table fed by its own informer
// (RunEventTriggerWatch; ADR 0048, docs/event-triggers.md §3–§4).

var EventTriggerGVR = schema.GroupVersionResource{
	Group: Group, Version: Version, Resource: "eventtriggers",
}

// --- CR shape (mirrors core-controller api/v1alpha1/eventtrigger_types.go) ---
//
// Restated rather than imported: this module does not depend on the
// controller's, and the JSON shape is the contract, not the Go types.

type EventTriggerMatch struct {
	CEL string `json:"cel,omitempty"`
}

type EventTriggerTarget struct {
	Orchestrator   *struct{} `json:"orchestrator,omitempty"`
	SkillRef       string    `json:"skillRef,omitempty"`
	AgentRef       string    `json:"agentRef,omitempty"`
	ToolRef        string    `json:"toolRef,omitempty"`
	PromptTemplate string    `json:"promptTemplate,omitempty"`
	ReadOnly       bool      `json:"readOnly,omitempty"`
}

type EventSecretKeySelector struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

type EventGitHubReply struct {
	Repository  string `json:"repository"`
	IssueNumber string `json:"issueNumber"`
	Ack         string `json:"ack,omitempty"`
	SessionPage bool   `json:"sessionPage,omitempty"`
	Result      bool   `json:"result,omitempty"`
	RemoveLabel string `json:"removeLabel,omitempty"`
}

// EventHTTPReply's URL is a literal and is never rendered: a reply target must
// come from operator config, not from event content, or a webhook body could
// point the gateway's POST anywhere (SSRF).
type EventHTTPReply struct {
	URL       string                  `json:"url"`
	SecretRef *EventSecretKeySelector `json:"secretRef,omitempty"`
}

type EventTriggerReply struct {
	GitHub *EventGitHubReply `json:"github,omitempty"`
	HTTP   *EventHTTPReply   `json:"http,omitempty"`
}

type EventTriggerSpec struct {
	SourceRef  string             `json:"sourceRef,omitempty"`
	Priority   int32              `json:"priority,omitempty"`
	Match      EventTriggerMatch  `json:"match,omitempty"`
	Params     map[string]string  `json:"params,omitempty"`
	SessionKey string             `json:"sessionKey,omitempty"`
	Target     EventTriggerTarget `json:"target"`
	Reply      *EventTriggerReply `json:"reply,omitempty"`
}

// --- the envelope (docs/event-triggers.md §2) ---

// Envelope is the normalized event every EventSource produces. It is both the
// `event` field of /invoke and the CEL activation.
type Envelope struct {
	Source     string            `json:"source"`
	Kind       string            `json:"kind"`
	ID         string            `json:"id"`
	Time       string            `json:"time"`
	Headers    map[string]string `json:"headers"`
	Body       any               `json:"body"`
	Sender     map[string]any    `json:"sender"`
	Repository string            `json:"repository"`
}

// activation is the envelope as CEL sees it. Every variable is always bound —
// an absent headers/sender is an EMPTY map, so `has(sender.login)` is false
// rather than an unbound-variable error — and every JSON number is normalized
// (see NormalizeJSONNumbers).
func (e Envelope) activation() map[string]any {
	headers := e.Headers
	if headers == nil {
		headers = map[string]string{}
	}
	sender, _ := NormalizeJSONNumbers(e.Sender).(map[string]any)
	if sender == nil {
		sender = map[string]any{}
	}
	return map[string]any{
		"source":     e.Source,
		"kind":       e.Kind,
		"id":         e.ID,
		"time":       e.Time,
		"repository": e.Repository,
		"headers":    headers,
		"body":       NormalizeJSONNumbers(e.Body),
		"sender":     sender,
	}
}

// NormalizeJSONNumbers applies §3's number rule: an integral JSON number is a
// CEL int, anything else a double. Without it every JSON number decodes as a
// Go float64 and `body.pull_request.number == 42` is a double-vs-int
// comparison — which cel-go and the JS runtime do not agree on, the exact
// cross-engine drift the parity fixtures exist to catch.
func NormalizeJSONNumbers(v any) any {
	switch value := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(value))
		for k, item := range value {
			out[k] = NormalizeJSONNumbers(item)
		}
		return out
	case []any:
		out := make([]any, len(value))
		for i, item := range value {
			out[i] = NormalizeJSONNumbers(item)
		}
		return out
	case float64:
		return normalizeFloat(value)
	case json.Number:
		// Integrality is decided on the VALUE, as the JS runtime (which only
		// ever sees a double) must: "1.0" and "1e3" are ints, and parsing the
		// spelling with Int64 first would disagree on both.
		if f, err := value.Float64(); err == nil {
			return normalizeFloat(f)
		}
		return value.String()
	case int:
		return int64(value)
	case int32:
		return int64(value)
	default:
		return v
	}
}

// normalizeFloat keeps a float as a double unless it is integral AND fits an
// int64; 1e300 is integral but would overflow, so it stays a double.
func normalizeFloat(f float64) any {
	if f == math.Trunc(f) && f >= -9.2233720368547758e18 && f < 9.2233720368547758e18 {
		return int64(f)
	}
	return f
}

// --- CEL (docs/event-triggers.md §3) ---

// eventEnv declares exactly the envelope's variables and nothing else, the same
// environment core-controller compiles against (internal/eventcel): anything
// outside the envelope is a compile error in both places.
var eventEnv = sync.OnceValues(func() (*cel.Env, error) {
	return cel.NewEnv(
		cel.Variable("source", cel.StringType),
		cel.Variable("kind", cel.StringType),
		cel.Variable("id", cel.StringType),
		cel.Variable("time", cel.StringType),
		cel.Variable("repository", cel.StringType),
		cel.Variable("headers", cel.MapType(cel.StringType, cel.StringType)),
		cel.Variable("body", cel.DynType),
		cel.Variable("sender", cel.MapType(cel.StringType, cel.DynType)),
	)
})

// celCostLimit bounds one evaluation. Expressions are operator-authored but
// run over attacker-shaped bodies, and nested macros over a large array are
// quadratic; a limit turns a pathological payload into a non-match/422 rather
// than a pinned gateway CPU. Generous enough that no realistic predicate
// approaches it.
const celCostLimit = 10_000_000

// CompiledExpr is one compiled CEL expression.
type CompiledExpr struct {
	prg cel.Program
}

// CompileEventExpr compiles (parses AND type-checks) expr against the
// envelope environment.
func CompileEventExpr(expr string) (*CompiledExpr, error) {
	return compileEventExpr(expr, nil)
}

// compileEventExpr additionally requires the checked result type be want (or
// dyn, which anything read from body is until evaluated). A match predicate
// that is statically not bool — `size(headers)`, say, as opposed to the dyn
// `body.draft` — is a compile error (§3), so the trigger is never Ready rather
// than silently never matching.
func compileEventExpr(expr string, want *cel.Type) (*CompiledExpr, error) {
	env, err := eventEnv()
	if err != nil {
		return nil, fmt.Errorf("building CEL environment: %w", err)
	}
	ast, iss := env.Compile(expr)
	if iss.Err() != nil {
		return nil, iss.Err()
	}
	if want != nil {
		if got := ast.OutputType(); !got.IsExactType(cel.DynType) && !got.IsExactType(want) {
			return nil, fmt.Errorf("expression yields %s, want %s", got, want)
		}
	}
	prg, err := env.Program(ast, cel.CostLimit(celCostLimit))
	if err != nil {
		return nil, err
	}
	return &CompiledExpr{prg: prg}, nil
}

// Eval evaluates against an envelope and returns the result as a plain Go
// value: nil, bool, int64, float64, string, []any or map[string]any.
func (c *CompiledExpr) Eval(e Envelope) (any, error) {
	return c.eval(e.activation())
}

func (c *CompiledExpr) eval(activation map[string]any) (any, error) {
	out, _, err := c.prg.Eval(activation)
	if err != nil {
		return nil, err
	}
	return celToNative(out)
}

// EvalEventExpr compiles and evaluates in one step; a compile error is an
// evaluation error. Used by the parity fixtures, where "does not compile" and
// "fails at runtime" are the same verdict.
func EvalEventExpr(expr string, e Envelope) (any, error) {
	c, err := CompileEventExpr(expr)
	if err != nil {
		return nil, err
	}
	return c.Eval(e)
}

// celToNative unwraps a CEL value into plain Go, recursively. Lists and maps
// read from body arrive as adapters over the original Go values, so they are
// walked through the CEL traits rather than type-asserted to Go collections.
func celToNative(v ref.Val) (any, error) {
	switch value := v.(type) {
	case *types.Err:
		return nil, value
	case types.Null:
		return nil, nil
	case types.Bool:
		return bool(value), nil
	case types.Int:
		return int64(value), nil
	case types.Double:
		// Only finite doubles: NaN/Infinity have no JSON form, so the two
		// engines could not agree on what a param holding one renders to.
		if math.IsNaN(float64(value)) || math.IsInf(float64(value), 0) {
			return nil, fmt.Errorf("non-finite double %v is not JSON-representable", float64(value))
		}
		return float64(value), nil
	case types.String:
		return string(value), nil
	}
	if list, ok := v.(traits.Lister); ok {
		size, ok := list.Size().(types.Int)
		if !ok {
			return nil, fmt.Errorf("list has no size")
		}
		out := make([]any, 0, int(size))
		for i := types.Int(0); i < size; i++ {
			item, err := celToNative(list.Get(i))
			if err != nil {
				return nil, err
			}
			out = append(out, item)
		}
		return out, nil
	}
	if m, ok := v.(traits.Mapper); ok {
		out := map[string]any{}
		it := m.Iterator()
		for it.HasNext() == types.True {
			key := it.Next()
			k, ok := key.(types.String)
			if !ok {
				return nil, fmt.Errorf("map key %v is not a string", key)
			}
			item, err := celToNative(m.Get(key))
			if err != nil {
				return nil, err
			}
			out[string(k)] = item
		}
		return out, nil
	}
	// Anything else — uint, bytes, a timestamp, a type value — is not
	// JSON-representable (§3), so it is an error rather than a lossy coercion
	// the JS runtime would make differently.
	return nil, fmt.Errorf("CEL result of type %s is not JSON-representable", v.Type().TypeName())
}

// ValueType names a native value's CEL type the way the parity fixtures do.
func ValueType(v any) string {
	switch v.(type) {
	case nil:
		return "null"
	case bool:
		return "bool"
	case int64:
		return "int"
	case float64:
		return "double"
	case string:
		return "string"
	case []any:
		return "list"
	case map[string]any:
		return "map"
	default:
		return fmt.Sprintf("%T", v)
	}
}

// --- templates (docs/event-triggers.md §4.4) ---

// templatePlaceholder is §4.4's pattern verbatim. Whitespace is spelled out
// rather than \s because the two regex dialects disagree on what \s covers.
var templatePlaceholder = regexp.MustCompile(`\{\{[ \t\n\f\r]*([^{} \t\n\f\r]+)[ \t\n\f\r]*\}\}`)

// RenderEventTemplate substitutes {{ name }} with each param's string form,
// in a single pass: a substituted value containing "{{x}}" (event content,
// so attacker-shaped) is never re-expanded.
//
// A flat substitution, not a templating engine: no conditionals, no
// filters, nothing an operator has to reason about beyond "this name becomes
// that value". An unknown placeholder is left verbatim rather than blanked, so
// a typo'd name shows up in the rendered prompt instead of silently producing
// an instruction with a hole in it.
func RenderEventTemplate(template string, params map[string]any) (string, error) {
	var renderErr error
	out := templatePlaceholder.ReplaceAllStringFunc(template, func(match string) string {
		name := templatePlaceholder.FindStringSubmatch(match)[1]
		value, ok := params[name]
		if !ok {
			return match
		}
		s, err := ParamString(value)
		if err != nil && renderErr == nil {
			renderErr = fmt.Errorf("param %q: %w", name, err)
		}
		return s
	})
	if renderErr != nil {
		return "", renderErr
	}
	return out, nil
}

// ParamString is a param's string form (§4.4): string as-is, int in decimal,
// double in shortest round-trip form (ECMAScript Number#toString, so both
// engines render the same text), bool true/false, null "", list/map as compact
// JSON with sorted keys.
func ParamString(v any) (string, error) {
	switch value := v.(type) {
	case nil:
		return "", nil
	case string:
		return value, nil
	case bool:
		return strconv.FormatBool(value), nil
	case int64:
		return strconv.FormatInt(value, 10), nil
	case int:
		return strconv.Itoa(value), nil
	case float64:
		return FormatJSNumber(value), nil
	default:
		return CompactJSON(value)
	}
}

// CompactJSON is JSON.stringify's output for a value whose map keys are
// sorted: no whitespace, and — unlike encoding/json's default — no HTML
// escaping of <, > and &, which JSON.stringify never does. encoding/json
// already sorts map keys and formats float64 the ES6 way.
func CompactJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

// FormatJSNumber renders a float64 exactly as ECMAScript Number::toString
// does (ECMA-262 §6.1.6.1.20): shortest round-trip digits, plain notation for
// decimal exponents in [-6, 21), exponential otherwise. strconv's 'g' switches
// to exponential at different thresholds (1e+06), which would render the same
// param differently in the two engines.
func FormatJSNumber(f float64) string {
	switch {
	case math.IsNaN(f):
		return "NaN"
	case math.IsInf(f, 1):
		return "Infinity"
	case math.IsInf(f, -1):
		return "-Infinity"
	case f == 0:
		return "0" // and -0, as JS renders it
	}
	sign := ""
	if f < 0 {
		sign = "-"
		f = -f
	}
	// Shortest round-trip digits plus a decimal exponent: "1.275e+01".
	mantissa, exponent, _ := strings.Cut(strconv.FormatFloat(f, 'e', -1, 64), "e")
	digits := strings.Replace(mantissa, ".", "", 1)
	exp, _ := strconv.Atoi(exponent)
	k, n := len(digits), exp+1

	switch {
	case k <= n && n <= 21:
		return sign + digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return sign + digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return sign + "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	expSign := "+"
	if e < 0 {
		expSign = "-"
		e = -e
	}
	if k == 1 {
		return sign + digits + "e" + expSign + strconv.Itoa(e)
	}
	return sign + digits[:1] + "." + digits[1:] + "e" + expSign + strconv.Itoa(e)
}

// --- the decoded trigger ---

// EventTriggerDescriptor is a decoded EventTrigger CR with its CEL compiled.
type EventTriggerDescriptor struct {
	Name  string           `json:"name"`
	Spec  EventTriggerSpec `json:"spec"`
	Ready bool             `json:"ready"`

	match  *CompiledExpr
	params map[string]*CompiledExpr
	// invalid is why this trigger can never match: CEL that does not compile,
	// or a target that is not exactly one of the four kinds. Held rather than
	// rejected at decode so an edit that BREAKS a trigger replaces the old,
	// working version in the registry instead of leaving it dispatching.
	invalid error
}

// Invalid reports why this trigger can never match, or nil.
func (d *EventTriggerDescriptor) Invalid() error { return d.invalid }

// NewEventTriggerDescriptor compiles a spec. It never fails: a trigger that
// cannot be compiled is returned with Invalid() set, and never matches
// (fail-closed, §1 "A trigger whose CEL fails to compile … never matches").
func NewEventTriggerDescriptor(name string, spec EventTriggerSpec, ready bool) *EventTriggerDescriptor {
	d := &EventTriggerDescriptor{Name: name, Spec: spec, Ready: ready}
	d.invalid = d.compile()
	return d
}

func (d *EventTriggerDescriptor) compile() error {
	// The controller's admission CEL enforces both of these; re-checked here
	// because a trigger with two targets would silently dispatch to one.
	targets := 0
	if d.Spec.Target.Orchestrator != nil {
		targets++
	}
	for _, ref := range []string{d.Spec.Target.SkillRef, d.Spec.Target.AgentRef, d.Spec.Target.ToolRef} {
		if ref != "" {
			targets++
		}
	}
	if targets != 1 {
		return fmt.Errorf("exactly one of orchestrator/skillRef/agentRef/toolRef must be set, got %d", targets)
	}
	if d.Spec.Target.ToolRef == "" && strings.TrimSpace(d.Spec.Target.PromptTemplate) == "" {
		return fmt.Errorf("promptTemplate is required unless toolRef is set")
	}

	if expr := strings.TrimSpace(d.Spec.Match.CEL); expr != "" {
		compiled, err := compileEventExpr(expr, cel.BoolType)
		if err != nil {
			return fmt.Errorf("match.cel: %w", err)
		}
		d.match = compiled
	}
	d.params = make(map[string]*CompiledExpr, len(d.Spec.Params))
	for name, expr := range d.Spec.Params {
		compiled, err := CompileEventExpr(expr)
		if err != nil {
			return fmt.Errorf("params.%s: %w", name, err)
		}
		d.params[name] = compiled
	}
	return nil
}

// DecodeEventTrigger reads an EventTrigger CR. Only an unreadable spec is an
// error; a spec that reads but does not compile decodes to a descriptor that
// never matches (see EventTriggerDescriptor.invalid).
func DecodeEventTrigger(obj *unstructured.Unstructured) (*EventTriggerDescriptor, error) {
	var spec EventTriggerSpec
	if err := decodeSpec(obj, &spec); err != nil {
		return nil, err
	}
	d := NewEventTriggerDescriptor(obj.GetName(), spec, readyCondition(obj))
	if d.invalid != nil {
		log.Printf("eventtriggers: %s can never match: %v", d.Name, d.invalid)
	}
	return d, nil
}

// readyCondition is status.conditions[type=Ready].status == "True" for the
// CR's current metadata.generation. §4 makes Ready a precondition of
// matching: core-controller is what checks that the target refs resolve,
// which this process cannot cheaply do. Absent status (not yet reconciled) is
// not Ready — fail closed.
//
// An edit bumps the generation but leaves the previous spec's status in place
// until the controller reconciles; a Ready=True whose observedGeneration is
// behind is that previous spec's verdict, so it does not count. Parity with
// the orchestrator's isControllerReady.
func readyCondition(obj *unstructured.Unstructured) bool {
	conditions, _, _ := unstructured.NestedSlice(obj.Object, "status", "conditions")
	for _, raw := range conditions {
		c, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		if c["type"] == "Ready" {
			observed, ok := asInt64(c["observedGeneration"])
			if !ok {
				observed = 0
			}
			return c["status"] == "True" && observed == obj.GetGeneration()
		}
	}
	return false
}

// asInt64 reads a JSON number from unstructured content, which decodes it as
// int64 off the wire but may hold float64 or int when built by hand.
func asInt64(v any) (int64, bool) {
	switch n := v.(type) {
	case int64:
		return n, true
	case int:
		return int64(n), true
	case float64:
		return int64(n), true
	}
	return 0, false
}

// --- matching (docs/event-triggers.md §4) ---

// RenderedGitHubReply is EventGitHubReply with every template rendered and
// issueNumber parsed to a number, as integration-gateway receives it.
type RenderedGitHubReply struct {
	Repository  string `json:"repository"`
	IssueNumber int64  `json:"issueNumber"`
	Ack         string `json:"ack,omitempty"`
	SessionPage bool   `json:"sessionPage,omitempty"`
	Result      bool   `json:"result,omitempty"`
	RemoveLabel string `json:"removeLabel,omitempty"`
}

type RenderedReply struct {
	GitHub *RenderedGitHubReply `json:"github,omitempty"`
	HTTP   *EventHTTPReply      `json:"http,omitempty"`
}

// TriggerMatch is the winning trigger plus everything rendered from it.
type TriggerMatch struct {
	Trigger *EventTriggerDescriptor
	// Params are the typed values; StringParams their §4.4 string forms (what
	// AgentRun.spec.params carries and templates substitute).
	Params       map[string]any
	StringParams map[string]string
	Prompt       string
	SessionID    string
	Reply        *RenderedReply
	// ToolInput is the one string a toolRef target's tool receives (§1).
	ToolInput string
}

// MatchError is a matched trigger whose params or templates failed: the event
// fails (422), it never falls through to another trigger or to retrieval.
type MatchError struct {
	Trigger string
	Err     error
}

func (e *MatchError) Error() string { return fmt.Sprintf("event trigger %s: %v", e.Trigger, e.Err) }
func (e *MatchError) Unwrap() error { return e.Err }

// EventTriggerRegistry is the live trigger table, kept current by
// RunEventTriggerWatch. Safe for concurrent use: the informer writes, request
// handlers read.
type EventTriggerRegistry struct {
	mu       sync.RWMutex
	triggers map[string]*EventTriggerDescriptor
}

func NewEventTriggerRegistry() *EventTriggerRegistry {
	return &EventTriggerRegistry{triggers: map[string]*EventTriggerDescriptor{}}
}

func (r *EventTriggerRegistry) Upsert(d *EventTriggerDescriptor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.triggers[d.Name] = d
}

func (r *EventTriggerRegistry) Delete(name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.triggers, name)
}

func (r *EventTriggerRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.triggers)
}

func (r *EventTriggerRegistry) snapshot() []*EventTriggerDescriptor {
	r.mu.RLock()
	defer r.mu.RUnlock()
	out := make([]*EventTriggerDescriptor, 0, len(r.triggers))
	for _, d := range r.triggers {
		out = append(out, d)
	}
	return out
}

// Match selects the single trigger an event dispatches (§4) and renders it.
// (nil, nil) is "no trigger matched" — a clean no-op, never a retrieval
// fallback. A *MatchError is a winner whose params/templates failed.
func (r *EventTriggerRegistry) Match(e Envelope, callerSessionID string) (*TriggerMatch, error) {
	return MatchEventTriggers(r.snapshot(), e, callerSessionID)
}

// MatchEventTriggers is Match over an explicit trigger list.
func MatchEventTriggers(triggers []*EventTriggerDescriptor, e Envelope, callerSessionID string) (*TriggerMatch, error) {
	activation := e.activation()

	candidates := make([]*EventTriggerDescriptor, 0, 2)
	for _, d := range triggers {
		if !d.Ready || d.invalid != nil {
			continue
		}
		if d.Spec.SourceRef != "" && d.Spec.SourceRef != e.Source {
			continue
		}
		if d.match != nil {
			verdict, err := d.match.eval(activation)
			if err != nil {
				// A missing field in this event's body is the common case — a
				// PR-shaped predicate evaluated against an issue event. That is
				// "this trigger is not about this event", not a failure.
				log.Printf("event trigger %s: match.cel errored on %s/%s, treating as no match: %v", d.Name, e.Source, e.ID, err)
				continue
			}
			matched, ok := verdict.(bool)
			if !ok {
				log.Printf("event trigger %s: match.cel yielded %s, not bool; treating as no match", d.Name, ValueType(verdict))
				continue
			}
			if !matched {
				continue
			}
		}
		candidates = append(candidates, d)
	}
	if len(candidates) == 0 {
		return nil, nil
	}

	// Highest priority, then the lexicographically smallest name: a total
	// order, so two processes holding the same triggers always pick the same
	// winner regardless of map iteration or informer delivery order.
	sort.Slice(candidates, func(i, j int) bool {
		if candidates[i].Spec.Priority != candidates[j].Spec.Priority {
			return candidates[i].Spec.Priority > candidates[j].Spec.Priority
		}
		return candidates[i].Name < candidates[j].Name
	})
	winner := candidates[0]

	m, err := render(winner, activation, e, callerSessionID)
	if err != nil {
		return nil, &MatchError{Trigger: winner.Name, Err: err}
	}
	return m, nil
}

func render(d *EventTriggerDescriptor, activation map[string]any, e Envelope, callerSessionID string) (*TriggerMatch, error) {
	m := &TriggerMatch{
		Trigger:      d,
		Params:       make(map[string]any, len(d.params)),
		StringParams: make(map[string]string, len(d.params)),
	}
	// Every param must evaluate. A param that errors after a match is a
	// failed event, never a silently empty value: an empty repository or
	// issue number would otherwise render into a prompt that LOOKS complete.
	for name, expr := range d.params {
		value, err := expr.eval(activation)
		if err != nil {
			return nil, fmt.Errorf("params.%s: %w", name, err)
		}
		s, err := ParamString(value)
		if err != nil {
			return nil, fmt.Errorf("params.%s: %w", name, err)
		}
		m.Params[name] = value
		m.StringParams[name] = s
	}

	var err error
	if m.Prompt, err = RenderEventTemplate(d.Spec.Target.PromptTemplate, m.Params); err != nil {
		return nil, fmt.Errorf("promptTemplate: %w", err)
	}

	sessionKey := ""
	if d.Spec.SessionKey != "" {
		if sessionKey, err = RenderEventTemplate(d.Spec.SessionKey, m.Params); err != nil {
			return nil, fmt.Errorf("sessionKey: %w", err)
		}
	}
	switch {
	case sessionKey != "":
		m.SessionID = sessionKey
	case callerSessionID != "":
		m.SessionID = callerSessionID
	default:
		m.SessionID = "event:" + e.Source + ":" + e.ID
	}

	if m.ToolInput, err = toolInput(m.Params); err != nil {
		return nil, fmt.Errorf("tool input: %w", err)
	}

	if d.Spec.Reply != nil {
		if m.Reply, err = renderReply(d.Spec.Reply, m.Params); err != nil {
			return nil, fmt.Errorf("reply: %w", err)
		}
	}
	return m, nil
}

// toolInput is the one string a toolRef target's tool receives (§1): the
// string form of params.input when that is the ONLY param, otherwise the
// whole params object as compact sorted-key JSON ("{}" with no params).
func toolInput(params map[string]any) (string, error) {
	if len(params) == 1 {
		if value, ok := params["input"]; ok {
			return ParamString(value)
		}
	}
	return CompactJSON(params)
}

// decimalDigits is the only spelling an issue number may render to: no sign,
// no whitespace, no exponent — strconv and Number() each accept some of those
// and would disagree on which.
var decimalDigits = regexp.MustCompile(`^[0-9]+$`)

func renderReply(reply *EventTriggerReply, params map[string]any) (*RenderedReply, error) {
	out := &RenderedReply{}
	if g := reply.GitHub; g != nil {
		rendered := &RenderedGitHubReply{SessionPage: g.SessionPage, Result: g.Result}
		var err error
		if rendered.Repository, err = RenderEventTemplate(g.Repository, params); err != nil {
			return nil, fmt.Errorf("github.repository: %w", err)
		}
		number, err := RenderEventTemplate(g.IssueNumber, params)
		if err != nil {
			return nil, fmt.Errorf("github.issueNumber: %w", err)
		}
		// A number, not a string, on the wire — and one that must actually BE
		// a number: "{{numbr}}" left verbatim by a typo must fail the event
		// rather than reach a GitHub API path.
		if !decimalDigits.MatchString(number) {
			return nil, fmt.Errorf("github.issueNumber rendered %q, not a positive integer", number)
		}
		if rendered.IssueNumber, err = strconv.ParseInt(number, 10, 64); err != nil || rendered.IssueNumber <= 0 {
			return nil, fmt.Errorf("github.issueNumber rendered %q, not a positive integer", number)
		}
		if rendered.Ack, err = RenderEventTemplate(g.Ack, params); err != nil {
			return nil, fmt.Errorf("github.ack: %w", err)
		}
		if rendered.RemoveLabel, err = RenderEventTemplate(g.RemoveLabel, params); err != nil {
			return nil, fmt.Errorf("github.removeLabel: %w", err)
		}
		out.GitHub = rendered
	}
	if h := reply.HTTP; h != nil {
		// Copied, never rendered: see EventHTTPReply.
		copied := *h
		out.HTTP = &copied
	}
	return out, nil
}
