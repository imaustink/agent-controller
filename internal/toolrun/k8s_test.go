package toolrun_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"durable-agents/internal/toolrun"
)

func newFakeDynamic() *dynamicfake.FakeDynamicClient {
	scheme := runtime.NewScheme()
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme,
		map[schema.GroupVersionResource]string{
			toolrun.ToolRunGVR: "ToolRunList",
		},
	)
}

func TestLaunchCreatesToolRunCR(t *testing.T) {
	client := newFakeDynamic()
	launcher := toolrun.NewK8sLauncher(client, "controller-agent", toolrun.SecretRef{Name: "cb-secret", Key: "AGENT_CALLBACK_SECRET"})

	spec := toolrun.LaunchSpec{
		Name:           "run-abc123",
		ToolRef:        "recipe-scraper",
		Args:           []string{"https://example.com/pasta"},
		CallbackURL:    "http://gateway:8081/callback/wf-1/run-abc123",
		TimeoutSeconds: 600,
	}
	require.NoError(t, launcher.Launch(context.Background(), spec))

	obj, err := client.Resource(toolrun.ToolRunGVR).Namespace("controller-agent").Get(context.Background(), "run-abc123", metav1.GetOptions{})
	require.NoError(t, err)

	toolRef, _, _ := unstructured.NestedString(obj.Object, "spec", "toolRef")
	require.Equal(t, "recipe-scraper", toolRef)
	url, _, _ := unstructured.NestedString(obj.Object, "spec", "callback", "url")
	require.Equal(t, spec.CallbackURL, url)
	secretName, _, _ := unstructured.NestedString(obj.Object, "spec", "callback", "secretRef", "name")
	require.Equal(t, "cb-secret", secretName)
	args, _, _ := unstructured.NestedStringSlice(obj.Object, "spec", "args")
	require.Equal(t, spec.Args, args)
	timeout, _, _ := unstructured.NestedInt64(obj.Object, "spec", "timeoutSeconds")
	require.EqualValues(t, 600, timeout)

	t.Run("relaunch with same name is idempotent", func(t *testing.T) {
		require.NoError(t, launcher.Launch(context.Background(), spec))
	})
}

func TestLaunchValidatesSpec(t *testing.T) {
	launcher := toolrun.NewK8sLauncher(newFakeDynamic(), "ns", toolrun.SecretRef{Name: "s", Key: "k"})
	require.Error(t, launcher.Launch(context.Background(), toolrun.LaunchSpec{Name: "x", ToolRef: "y"})) // no callback URL
}

// Per-invocation credentials ride the ToolRun as secretEnv (upstream ADR
// 0032 §1), merged over the Tool's static secretEnv by the reconciler.
func TestLaunchWritesSecretEnv(t *testing.T) {
	client := newFakeDynamic()
	launcher := toolrun.NewK8sLauncher(client, "ns", toolrun.SecretRef{Name: "cb", Key: "k"})

	require.NoError(t, launcher.Launch(context.Background(), toolrun.LaunchSpec{
		Name:        "run-gh",
		ToolRef:     "github",
		CallbackURL: "http://gateway/callback/wf-1/run-gh",
		SecretEnv: []toolrun.SecretEnvVar{{
			Name:      "GITHUB_TOKEN",
			SecretRef: toolrun.SecretKeySelector{Name: "run-gh-identity", Key: "GITHUB_TOKEN"},
		}},
	}))

	obj, err := client.Resource(toolrun.ToolRunGVR).Namespace("ns").Get(context.Background(), "run-gh", metav1.GetOptions{})
	require.NoError(t, err)

	entries, found, err := unstructured.NestedSlice(obj.Object, "spec", "secretEnv")
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, []any{map[string]any{
		"name":      "GITHUB_TOKEN",
		"secretRef": map[string]any{"name": "run-gh-identity", "key": "GITHUB_TOKEN"},
	}}, entries)

	t.Run("omitted entirely when there are no credentials", func(t *testing.T) {
		require.NoError(t, launcher.Launch(context.Background(), toolrun.LaunchSpec{
			Name: "run-plain", ToolRef: "web-fetch", CallbackURL: "http://gateway/callback/wf-1/run-plain",
		}))
		plain, err := client.Resource(toolrun.ToolRunGVR).Namespace("ns").Get(context.Background(), "run-plain", metav1.GetOptions{})
		require.NoError(t, err)
		_, found, err := unstructured.NestedSlice(plain.Object, "spec", "secretEnv")
		require.NoError(t, err)
		require.False(t, found)
	})

	// A half-built entry would render a ToolRun the reconciler rejects at
	// Job-build time, surfacing as an opaque launch failure minutes later.
	t.Run("rejects an incomplete secret reference", func(t *testing.T) {
		err := launcher.Launch(context.Background(), toolrun.LaunchSpec{
			Name: "run-bad", ToolRef: "github", CallbackURL: "http://gateway/callback/wf-1/run-bad",
			SecretEnv: []toolrun.SecretEnvVar{{Name: "GITHUB_TOKEN"}},
		})
		require.ErrorContains(t, err, "secretEnv[0]")
	})
}

func TestGetStatus(t *testing.T) {
	client := newFakeDynamic()
	launcher := toolrun.NewK8sLauncher(client, "ns", toolrun.SecretRef{Name: "s", Key: "k"})

	t.Run("missing CR reports not found without error", func(t *testing.T) {
		status, err := launcher.GetStatus(context.Background(), "nope")
		require.NoError(t, err)
		require.Empty(t, status.Phase)
		require.Contains(t, status.Message, "not found")
	})

	t.Run("mirrors status fields", func(t *testing.T) {
		_, err := client.Resource(toolrun.ToolRunGVR).Namespace("ns").Create(context.Background(), &unstructured.Unstructured{Object: map[string]any{
			"apiVersion": "core.controller-agent.dev/v1alpha1",
			"kind":       "ToolRun",
			"metadata":   map[string]any{"name": "done", "namespace": "ns"},
			"status":     map[string]any{"phase": "Failed", "message": "Job deadline exceeded", "jobName": "toolrun-done"},
		}}, metav1.CreateOptions{})
		require.NoError(t, err)

		status, err := launcher.GetStatus(context.Background(), "done")
		require.NoError(t, err)
		require.Equal(t, toolrun.PhaseFailed, status.Phase)
		require.Equal(t, "Job deadline exceeded", status.Message)
		require.Equal(t, "toolrun-done", status.JobName)
	})
}
