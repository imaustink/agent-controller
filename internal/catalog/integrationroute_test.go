package catalog_test

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"durable-agents/internal/catalog"
)

func route(id, source, event, action, labelName, agentRef string) catalog.IntegrationRouteDescriptor {
	return catalog.IntegrationRouteDescriptor{
		ID: id,
		Match: catalog.IntegrationRouteMatch{
			Source: source, Event: event, Action: action, LabelName: labelName,
		},
		AgentRef:       agentRef,
		PromptTemplate: "handle it",
	}
}

func TestRouteRegistryMatch(t *testing.T) {
	reg := catalog.NewRouteRegistry()
	reg.Upsert(route("triage", "github", "issues", "labeled", "ai-triage", "swe-agent"))
	reg.Upsert(route("review", "github", "pull_request", "labeled", "ai-review", "review-agent"))
	reg.Upsert(route("any-issue", "github", "issues", "", "", "fallback-agent"))

	t.Run("exact action and label", func(t *testing.T) {
		got, ok := reg.Match("github", "issues", "labeled", "ai-triage")
		require.True(t, ok)
		require.Equal(t, "triage", got.ID)
	})

	// The whole reason labelName exists: one source/event/action triple
	// carries more than one intent, so a route naming a label must not
	// swallow events carrying a different one.
	t.Run("a differing label is a miss, not a fallback to that route", func(t *testing.T) {
		got, ok := reg.Match("github", "issues", "labeled", "ai-review")
		require.True(t, ok)
		require.Equal(t, "any-issue", got.ID, "falls to the wildcard route, never to the ai-triage one")
	})

	t.Run("wildcard route matches any action", func(t *testing.T) {
		got, ok := reg.Match("github", "issues", "closed", "")
		require.True(t, ok)
		require.Equal(t, "any-issue", got.ID)
	})

	t.Run("unknown source or event misses entirely", func(t *testing.T) {
		_, ok := reg.Match("slack", "message", "posted", "")
		require.False(t, ok)
		_, ok = reg.Match("github", "release", "published", "")
		require.False(t, ok)
	})

	t.Run("delete removes the route", func(t *testing.T) {
		reg.Delete("any-issue")
		_, ok := reg.Match("github", "issues", "closed", "")
		require.False(t, ok)
	})
}

func TestRouteRegistryPrefersTheMostSpecificRoute(t *testing.T) {
	reg := catalog.NewRouteRegistry()
	reg.Upsert(route("wildcard", "github", "issues", "", "", "a"))
	reg.Upsert(route("label-only", "github", "issues", "", "ai-triage", "b"))
	reg.Upsert(route("action-only", "github", "issues", "labeled", "", "c"))
	reg.Upsert(route("both", "github", "issues", "labeled", "ai-triage", "d"))

	got, ok := reg.Match("github", "issues", "labeled", "ai-triage")
	require.True(t, ok)
	require.Equal(t, "both", got.ID)

	reg.Delete("both")
	got, _ = reg.Match("github", "issues", "labeled", "ai-triage")
	require.Equal(t, "action-only", got.ID)

	reg.Delete("action-only")
	got, _ = reg.Match("github", "issues", "labeled", "ai-triage")
	require.Equal(t, "label-only", got.ID)

	reg.Delete("label-only")
	got, _ = reg.Match("github", "issues", "labeled", "ai-triage")
	require.Equal(t, "wildcard", got.ID)
}

// Map iteration order is random in Go, so an unstable tie-break would make two
// processes holding identical routes dispatch differently. Two routes tying is
// an operator authoring mistake either way — but it must at least be the same
// mistake everywhere.
func TestRouteRegistryTieBreakIsDeterministic(t *testing.T) {
	for i := 0; i < 20; i++ {
		reg := catalog.NewRouteRegistry()
		reg.Upsert(route("zeta", "github", "issues", "labeled", "", "z"))
		reg.Upsert(route("alpha", "github", "issues", "labeled", "", "a"))
		got, ok := reg.Match("github", "issues", "labeled", "")
		require.True(t, ok)
		require.Equal(t, "alpha", got.ID)
	}
}

func TestRenderPromptTemplate(t *testing.T) {
	fields := map[string]string{
		"owner": "acme", "repo": "widgets", "issueNumber": "7", "title": "Crash on save",
	}

	require.Equal(t,
		"Triage acme/widgets#7: Crash on save",
		catalog.RenderPromptTemplate("Triage {{owner}}/{{repo}}#{{issueNumber}}: {{title}}", fields))

	require.Equal(t, "spaced acme", catalog.RenderPromptTemplate("spaced {{ owner }}", fields))

	// An operator's typo must be visible in the prompt, not silently rendered
	// as an instruction with a hole in it.
	require.Equal(t,
		"Triage acme and {{ownr}}",
		catalog.RenderPromptTemplate("Triage {{owner}} and {{ownr}}", fields))

	require.Equal(t, "no placeholders", catalog.RenderPromptTemplate("no placeholders", fields))
}

func TestEventFields(t *testing.T) {
	fields := catalog.EventFields(map[string]any{
		"source":      "github",
		"issueNumber": float64(7), // JSON numbers decode as float64
		"score":       1.5,
		"draft":       false,
		"labels":      []any{"a", "b"},  // dropped: not a scalar
		"assignee":    map[string]any{}, // dropped: not a scalar
		"body":        nil,              // dropped: nothing to interpolate
	})

	require.Equal(t, "github", fields["source"])
	require.Equal(t, "7", fields["issueNumber"], "an issue number must not render as 7.000000")
	require.Equal(t, "1.5", fields["score"])
	require.Equal(t, "false", fields["draft"])
	require.NotContains(t, fields, "labels")
	require.NotContains(t, fields, "assignee")
	require.NotContains(t, fields, "body")
}

func TestRunRouteWatchKeepsTheRegistryCurrent(t *testing.T) {
	scheme := runtime.NewScheme()
	client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{
			catalog.IntegrationRouteGVR: "IntegrationRouteList",
		},
	)
	routes := client.Resource(catalog.IntegrationRouteGVR).Namespace("ns")

	// Present before the watch starts: the informer's initial list is the
	// startup full sync.
	_, err := routes.Create(context.Background(), routeCR("triage", map[string]any{
		"match":          map[string]any{"source": "github", "event": "issues", "action": "labeled"},
		"agentRef":       "swe-agent",
		"promptTemplate": "Triage {{repo}}",
	}), metav1.CreateOptions{})
	require.NoError(t, err)

	// A malformed route must not take the table down with it — the others
	// keep routing and this one is simply absent, which is the same outcome
	// as no route at all.
	_, err = routes.Create(context.Background(), routeCR("broken", map[string]any{
		"match":          map[string]any{"source": "github", "event": "push"},
		"skillRef":       "s",
		"agentRef":       "a", // two targets: rejected at decode
		"promptTemplate": "x",
	}), metav1.CreateOptions{})
	require.NoError(t, err)

	reg := catalog.NewRouteRegistry()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- catalog.RunRouteWatch(ctx, client, "ns", reg) }()

	require.Eventually(t, func() bool {
		_, ok := reg.Match("github", "issues", "labeled", "")
		return ok
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, 1, reg.Len(), "the malformed route is skipped, not fatal")

	_, err = routes.Create(context.Background(), routeCR("review", map[string]any{
		"match":          map[string]any{"source": "github", "event": "pull_request", "action": "labeled", "labelName": "ai-review"},
		"agentRef":       "review-agent",
		"promptTemplate": "Review {{repo}}",
	}), metav1.CreateOptions{})
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		_, ok := reg.Match("github", "pull_request", "labeled", "ai-review")
		return ok
	}, 5*time.Second, 10*time.Millisecond)

	require.NoError(t, routes.Delete(context.Background(), "triage", metav1.DeleteOptions{}))
	require.Eventually(t, func() bool {
		_, ok := reg.Match("github", "issues", "labeled", "")
		return !ok
	}, 5*time.Second, 10*time.Millisecond)

	// Shutting down returns cleanly. This asserts more than it looks: the
	// informer's cache sync poll runs on a 100ms period, so a test this fast
	// cancels mid-sync — the exact case that used to report a cache failure
	// that had not happened.
	cancel()
	require.NoError(t, <-done)
}
