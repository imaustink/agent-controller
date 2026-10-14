package catalog_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"github.com/controller-agent/temporal-engine/internal/catalog"
)

func triggerCR(name string, spec map[string]any, ready string) *unstructured.Unstructured {
	obj := map[string]any{
		"apiVersion": "core.controller-agent.dev/v1alpha1",
		"kind":       "EventTrigger",
		"metadata":   map[string]any{"name": name, "namespace": "ns", "generation": int64(1)},
		"spec":       spec,
	}
	if ready != "" {
		obj["status"] = map[string]any{"conditions": []any{
			map[string]any{"type": "Ready", "status": ready, "observedGeneration": int64(1)},
		}}
	}
	return &unstructured.Unstructured{Object: obj}
}

func prEnvelope() catalog.Envelope {
	return catalog.Envelope{
		Source: "github", Kind: "webhook", ID: "d-1",
		Headers: map[string]string{"x-github-event": "pull_request"},
		Body: map[string]any{
			"action":       "labeled",
			"label":        map[string]any{"name": "ai-review"},
			"pull_request": map[string]any{"number": float64(42)},
			"repository":   map[string]any{"full_name": "acme/widgets"},
		},
		Repository: "acme/widgets",
	}
}

func TestDecodeEventTrigger(t *testing.T) {
	d, err := catalog.DecodeEventTrigger(triggerCR("review", map[string]any{
		"sourceRef": "github",
		"priority":  int64(5),
		"match":     map[string]any{"cel": `body.label.name == "ai-review"`},
		"params":    map[string]any{"number": "body.pull_request.number"},
		"target":    map[string]any{"agentRef": "swe", "readOnly": true, "promptTemplate": "Review #{{number}}"},
	}, "True"))
	require.NoError(t, err)
	require.NoError(t, d.Invalid())
	require.True(t, d.Ready)
	require.Equal(t, int32(5), d.Spec.Priority)
	require.True(t, d.Spec.Target.ReadOnly)

	m, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{d}, prEnvelope(), "")
	require.NoError(t, err)
	require.NotNil(t, m)
	require.Equal(t, "Review #42", m.Prompt)
	require.Equal(t, map[string]string{"number": "42"}, m.StringParams)
}

// Ready is core-controller's verdict that the target refs resolve. An
// unreconciled or NotReady trigger must not dispatch — fail closed.
func TestEventTriggerRequiresReady(t *testing.T) {
	spec := map[string]any{"target": map[string]any{"orchestrator": map[string]any{}, "promptTemplate": "x"}}
	for _, ready := range []string{"", "False", "Unknown"} {
		d, err := catalog.DecodeEventTrigger(triggerCR("t", spec, ready))
		require.NoError(t, err)
		m, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{d}, prEnvelope(), "")
		require.NoError(t, err)
		require.Nil(t, m, "Ready=%q must not match", ready)
	}
}

// An edit bumps metadata.generation and leaves the previous spec's Ready
// condition in place until the controller re-checks; that stale True must not
// dispatch the new, unchecked spec.
func TestEventTriggerStaleReadyDoesNotMatch(t *testing.T) {
	spec := map[string]any{"target": map[string]any{"orchestrator": map[string]any{}, "promptTemplate": "x"}}
	cr := triggerCR("t", spec, "True")
	cr.SetGeneration(2)
	d, err := catalog.DecodeEventTrigger(cr)
	require.NoError(t, err)
	require.False(t, d.Ready)
	m, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{d}, prEnvelope(), "")
	require.NoError(t, err)
	require.Nil(t, m)

	// Once the controller has reconciled generation 2, it matches again.
	conditions := cr.Object["status"].(map[string]any)["conditions"].([]any)
	conditions[0].(map[string]any)["observedGeneration"] = int64(2)
	d, err = catalog.DecodeEventTrigger(cr)
	require.NoError(t, err)
	require.True(t, d.Ready)
}

func TestEventTriggerInvalidTargetsNeverMatch(t *testing.T) {
	for name, target := range map[string]catalog.EventTriggerTarget{
		"two targets":         {SkillRef: "s", AgentRef: "a", PromptTemplate: "x"},
		"no target":           {PromptTemplate: "x"},
		"no prompt for skill": {SkillRef: "s"},
	} {
		d := catalog.NewEventTriggerDescriptor(name, catalog.EventTriggerSpec{Target: target}, true)
		require.Error(t, d.Invalid(), name)
		m, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{d}, prEnvelope(), "")
		require.NoError(t, err)
		require.Nil(t, m, name)
	}

	// A match that is statically not bool is a compile error (§3), so the
	// trigger is never Ready; a dyn one is only judged at runtime.
	nonBool := catalog.NewEventTriggerDescriptor("t", catalog.EventTriggerSpec{
		Match:  catalog.EventTriggerMatch{CEL: "size(headers)"},
		Target: catalog.EventTriggerTarget{Orchestrator: &struct{}{}, PromptTemplate: "x"},
	}, true)
	require.ErrorContains(t, nonBool.Invalid(), "want bool")
	dynMatch := catalog.NewEventTriggerDescriptor("t", catalog.EventTriggerSpec{
		Match:  catalog.EventTriggerMatch{CEL: "body.action"},
		Target: catalog.EventTriggerTarget{Orchestrator: &struct{}{}, PromptTemplate: "x"},
	}, true)
	require.NoError(t, dynMatch.Invalid())
	m, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{dynMatch}, prEnvelope(), "")
	require.NoError(t, err)
	require.Nil(t, m, "a runtime non-bool is a non-match")

	// A toolRef needs no prompt: its params are the input.
	d := catalog.NewEventTriggerDescriptor("tool", catalog.EventTriggerSpec{Target: catalog.EventTriggerTarget{ToolRef: "t"}}, true)
	require.NoError(t, d.Invalid())
}

func TestEventTriggerToolInput(t *testing.T) {
	match := func(params map[string]string) string {
		d := catalog.NewEventTriggerDescriptor("t", catalog.EventTriggerSpec{
			Params: params,
			Target: catalog.EventTriggerTarget{ToolRef: "tool"},
		}, true)
		m, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{d}, prEnvelope(), "")
		require.NoError(t, err)
		require.NotNil(t, m)
		return m.ToolInput
	}
	require.Equal(t, "{}", match(nil))
	require.Equal(t, "acme/widgets", match(map[string]string{"input": "body.repository.full_name"}))
	require.Equal(t, `{"input":"acme/widgets","n":42}`,
		match(map[string]string{"input": "body.repository.full_name", "n": "body.pull_request.number"}))
}

func TestEventTriggerReplyIssueNumberMustBeANumber(t *testing.T) {
	d := catalog.NewEventTriggerDescriptor("t", catalog.EventTriggerSpec{
		Target: catalog.EventTriggerTarget{Orchestrator: &struct{}{}, PromptTemplate: "x"},
		Reply: &catalog.EventTriggerReply{GitHub: &catalog.EventGitHubReply{
			Repository: "acme/widgets", IssueNumber: "{{numbr}}", // typo: left verbatim
		}},
	}, true)
	_, err := catalog.MatchEventTriggers([]*catalog.EventTriggerDescriptor{d}, prEnvelope(), "")
	var matchErr *catalog.MatchError
	require.ErrorAs(t, err, &matchErr)
	require.Equal(t, "t", matchErr.Trigger)
}

func TestFormatJSNumber(t *testing.T) {
	for in, want := range map[float64]string{
		12.75:     "12.75",
		0.1:       "0.1",
		5:         "5",
		-3.5:      "-3.5",
		1e6:       "1000000",
		1e21:      "1e+21",
		1.5e21:    "1.5e+21",
		1e-6:      "0.000001",
		1e-7:      "1e-7",
		123.456e5: "12345600",
		-1.25e-9:  "-1.25e-9",
	} {
		require.Equal(t, want, catalog.FormatJSNumber(in), "%v", in)
	}
}

func TestRunEventTriggerWatchKeepsTheRegistryCurrent(t *testing.T) {
	scheme := runtime.NewScheme()
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{catalog.EventTriggerGVR: "EventTriggerList"},
	)
	triggers := client.Resource(catalog.EventTriggerGVR).Namespace("ns")

	review := map[string]any{
		"match":  map[string]any{"cel": `body.label.name == "ai-review"`},
		"target": map[string]any{"agentRef": "swe", "promptTemplate": "Review"},
	}
	_, err := triggers.Create(context.Background(), triggerCR("review", review, "True"), metav1.CreateOptions{})
	require.NoError(t, err)

	reg := catalog.NewEventTriggerRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- catalog.RunEventTriggerWatch(ctx, client, "ns", reg) }()

	matches := func() bool {
		m, err := reg.Match(prEnvelope(), "")
		return err == nil && m != nil
	}
	require.Eventually(t, matches, 5*time.Second, 10*time.Millisecond)

	// An edit that breaks the CEL must REPLACE the working version, not leave
	// it dispatching: the trigger stops matching.
	broken := map[string]any{
		"match":  map[string]any{"cel": `body.label.name ==`},
		"target": map[string]any{"agentRef": "swe", "promptTemplate": "Review"},
	}
	_, err = triggers.Update(context.Background(), triggerCR("review", broken, "True"), metav1.UpdateOptions{})
	require.NoError(t, err)
	require.Eventually(t, func() bool { return !matches() }, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, 1, reg.Len(), "the broken trigger is held, as a never-matching entry")

	require.NoError(t, triggers.Delete(context.Background(), "review", metav1.DeleteOptions{}))
	require.Eventually(t, func() bool { return reg.Len() == 0 }, 5*time.Second, 10*time.Millisecond)

	cancel()
	require.NoError(t, <-done)
}
