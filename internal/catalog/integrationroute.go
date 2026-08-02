package catalog

import (
	"fmt"

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
