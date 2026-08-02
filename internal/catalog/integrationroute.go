package catalog

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
	"sync"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// IntegrationRoute lives in this package because it is decoded from the same
// API group as the rest of the catalog, but it is deliberately NOT part of
// Indexer: routes are matched by exact string equality, never retrieved by
// similarity, so embedding them into Qdrant would cost a vector round trip to
// answer a map lookup — and would put a routing table into the candidate set
// the skill/tool catalogs' own recall depends on. The registry that holds them
// is a plain in-memory table fed by the same informer (upstream ADR 0024).

var IntegrationRouteGVR = schema.GroupVersionResource{
	Group: Group, Version: Version, Resource: "integrationroutes",
}

// IntegrationRouteMatch selects which inbound gateway events a route applies
// to. Matching is exact — no globs, no expressions, no ordering for an
// operator to reason about. Upstream ADR 0024 is explicit that this is a
// declarative table and not a rules engine.
type IntegrationRouteMatch struct {
	// Source is the adapter that produced the event (e.g. "github").
	Source string `json:"source"`
	// Event is the adapter-specific event name (e.g. "issues").
	Event string `json:"event"`
	// Action is the adapter-specific sub-action (e.g. "labeled"). Empty
	// matches any action for this source/event pair.
	Action string `json:"action,omitempty"`
	// LabelName narrows a match to events carrying this exact label. Empty
	// matches any label. Needed because one source/event/action triple can
	// carry more than one intent: GitHub's pull_request/labeled means "review
	// this PR" under one label and "address the feedback and sync it" under
	// another, and nothing else in the descriptor tells them apart.
	LabelName string `json:"labelName,omitempty"`
}

// IntegrationRouteDescriptor is a decoded IntegrationRoute CR. Exactly one of
// SkillRef/AgentRef/ToolRef is set (CEL-enforced upstream); DecodeIntegrationRoute
// re-checks rather than trusting the cluster, since a route with two targets
// would silently pick one.
type IntegrationRouteDescriptor struct {
	ID    string                `json:"id"` // CR name
	Match IntegrationRouteMatch `json:"match"`

	SkillRef string `json:"skillRef,omitempty"`
	AgentRef string `json:"agentRef,omitempty"`
	ToolRef  string `json:"toolRef,omitempty"`

	// PromptTemplate is the request sent to the target, with {{field}}
	// placeholders substituted from the matched event's fields.
	PromptTemplate string `json:"promptTemplate"`
}

// Specificity ranks a matching route so the most specific wins:
// action+labelName (3) > action (2) > labelName (1) > neither (0). Mirrors
// upstream's CrdIntegrationRouteRegistry.match ordering.
func (r IntegrationRouteDescriptor) Specificity() int {
	score := 0
	if r.Match.Action != "" {
		score += 2
	}
	if r.Match.LabelName != "" {
		score++
	}
	return score
}

type integrationRouteSpec struct {
	Match          IntegrationRouteMatch `json:"match"`
	SkillRef       string                `json:"skillRef,omitempty"`
	AgentRef       string                `json:"agentRef,omitempty"`
	ToolRef        string                `json:"toolRef,omitempty"`
	PromptTemplate string                `json:"promptTemplate"`
}

func DecodeIntegrationRoute(obj *unstructured.Unstructured) (IntegrationRouteDescriptor, error) {
	var spec integrationRouteSpec
	if err := decodeSpec(obj, &spec); err != nil {
		return IntegrationRouteDescriptor{}, err
	}

	name := obj.GetName()
	if spec.Match.Source == "" || spec.Match.Event == "" {
		return IntegrationRouteDescriptor{}, fmt.Errorf("IntegrationRoute %q: match.source and match.event are required", name)
	}
	if spec.PromptTemplate == "" {
		return IntegrationRouteDescriptor{}, fmt.Errorf("IntegrationRoute %q: promptTemplate is required", name)
	}

	targets := 0
	for _, ref := range []string{spec.SkillRef, spec.AgentRef, spec.ToolRef} {
		if ref != "" {
			targets++
		}
	}
	if targets != 1 {
		return IntegrationRouteDescriptor{}, fmt.Errorf(
			"IntegrationRoute %q: exactly one of skillRef/agentRef/toolRef must be set, got %d", name, targets)
	}

	return IntegrationRouteDescriptor{
		ID:             name,
		Match:          spec.Match,
		SkillRef:       spec.SkillRef,
		AgentRef:       spec.AgentRef,
		ToolRef:        spec.ToolRef,
		PromptTemplate: spec.PromptTemplate,
	}, nil
}

// RouteRegistry is the live event->target table, kept current by
// RunRouteWatch. Safe for concurrent use: the informer writes, request
// handlers read.
type RouteRegistry struct {
	mu     sync.RWMutex
	routes map[string]IntegrationRouteDescriptor
}

func NewRouteRegistry() *RouteRegistry {
	return &RouteRegistry{routes: map[string]IntegrationRouteDescriptor{}}
}

func (r *RouteRegistry) Upsert(route IntegrationRouteDescriptor) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.routes[route.ID] = route
}

func (r *RouteRegistry) Delete(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.routes, id)
}

func (r *RouteRegistry) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.routes)
}

// Match finds the route for an event, if any.
//
// source/event must match exactly. action and labelName match exactly when
// the route names one and act as a wildcard when the route omits it — naming
// one and having it differ is a MISS, not a fallback, otherwise an ai-review
// route would swallow ai-triage. Most specific wins (see Specificity).
//
// Ties within a specificity tier resolve to the lexicographically smallest
// route id. Upstream resolves them to whichever route was indexed last, which
// is insertion-order-dependent; here the table is a Go map, so relying on that
// would make dispatch differ between two processes holding identical routes.
// A stable rule is worth more than bug-compatibility with an arbitrary one —
// and either way, two routes tying is an operator authoring mistake.
func (r *RouteRegistry) Match(source, event, action, labelName string) (IntegrationRouteDescriptor, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	candidates := make([]IntegrationRouteDescriptor, 0, 2)
	for _, route := range r.routes {
		if route.Match.Source != source || route.Match.Event != event {
			continue
		}
		if route.Match.Action != "" && route.Match.Action != action {
			continue
		}
		if route.Match.LabelName != "" && route.Match.LabelName != labelName {
			continue
		}
		candidates = append(candidates, route)
	}
	if len(candidates) == 0 {
		return IntegrationRouteDescriptor{}, false
	}
	sort.Slice(candidates, func(i, j int) bool {
		if si, sj := candidates[i].Specificity(), candidates[j].Specificity(); si != sj {
			return si > sj
		}
		return candidates[i].ID < candidates[j].ID
	})
	return candidates[0], true
}

var promptPlaceholder = regexp.MustCompile(`\{\{\s*([a-zA-Z0-9_]+)\s*\}\}`)

// RenderPromptTemplate substitutes {{field}} placeholders with values from the
// matched event's fields. A flat string replace, not a templating engine: the
// substitution set (owner, repo, issueNumber, title, body, senderLogin,
// labelName…) is small and adapter-defined, and upstream's ADR 0024 is
// explicit that this must not become a rules engine.
//
// An unmatched placeholder is left verbatim rather than blanked, so a typo'd
// field name in an operator-authored template shows up in the prompt instead
// of silently rendering an instruction with a hole in it.
func RenderPromptTemplate(template string, fields map[string]string) string {
	return promptPlaceholder.ReplaceAllStringFunc(template, func(match string) string {
		field := promptPlaceholder.FindStringSubmatch(match)[1]
		if value, ok := fields[field]; ok {
			return value
		}
		return match
	})
}

// EventFields flattens an adapter's event descriptor into the string map
// RenderPromptTemplate substitutes from. Nested objects and nulls are dropped
// — a template can only interpolate scalars, and rendering "[object Object]"
// into a prompt helps nobody.
func EventFields(raw map[string]any) map[string]string {
	fields := make(map[string]string, len(raw))
	for k, v := range raw {
		switch value := v.(type) {
		case string:
			fields[k] = value
		case bool:
			fields[k] = fmt.Sprintf("%t", value)
		case float64:
			// JSON numbers decode as float64; render integers without the
			// trailing ".000000" an issue number would otherwise pick up.
			if value == float64(int64(value)) {
				fields[k] = fmt.Sprintf("%d", int64(value))
			} else {
				fields[k] = strings.TrimRight(strings.TrimRight(fmt.Sprintf("%f", value), "0"), ".")
			}
		case int, int32, int64:
			fields[k] = fmt.Sprintf("%d", value)
		}
	}
	return fields
}
