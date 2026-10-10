package authz

// Internal test: secretName is unexported, and it encodes a constraint
// (object names are not arbitrary strings) that is easy to regress.

import (
	"context"
	"regexp"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
)

// dns1123 is what Kubernetes will actually accept for an object name.
var dns1123 = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)

func TestSecretNameIsAlwaysAValidObjectName(t *testing.T) {
	for _, runID := range []string{
		"claude-code-swe-agent-openwebui:1234",
		"a-github:ImAustink",
		// A real IdP `sub` is long, mixed-case, and punctuated.
		"agent-https://accounts.example.com/|auth0|5f8a9c2b3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a",
		"agent-",
		"-",
		":",
		"",
	} {
		name := secretName(runID)
		require.Regexp(t, dns1123, name, "run id %q produced an invalid name", runID)
		require.LessOrEqual(t, len(name), 253)
		require.NotEmpty(t, name)
	}
}

// Content-derived, so the same caller relaunching the same agent reuses one
// object rather than littering one per attempt — and two different callers
// never collide.
func TestSecretNameIsStableAndDistinct(t *testing.T) {
	require.Equal(t, secretName("a-openwebui:1"), secretName("a-openwebui:1"))
	require.NotEqual(t, secretName("a-openwebui:1"), secretName("a-openwebui:2"))

	// Sanitizing alone would collide these two; the hash suffix is what keeps
	// them apart.
	require.NotEqual(t, secretName("a-github:x"), secretName("a-github/x"))
}

func newSecretClient() *dynamicfake.FakeDynamicClient {
	return dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
		map[schema.GroupVersionResource]string{secretGVR: "SecretList"})
}

func TestWriteRunCredentialsUsesStringData(t *testing.T) {
	client := newSecretClient()
	w := NewK8sSecretWriter(client, "durable-agents")

	name, err := w.WriteRunCredentials(context.Background(), "agent-openwebui:1234", map[string]string{
		"GITHUB_TOKEN":      "gho_secret",
		"AGENT_ACTOR_LOGIN": "imaustink",
	})
	require.NoError(t, err)
	require.NotEmpty(t, name)

	obj, err := client.Resource(secretGVR).Namespace("durable-agents").
		Get(context.Background(), name, metav1.GetOptions{})
	require.NoError(t, err)

	// stringData, not data: the API server does the encoding, so no encoded
	// credential passes through this process's own formatting.
	stringData, found, err := unstructured.NestedStringMap(obj.Object, "stringData")
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, "gho_secret", stringData["GITHUB_TOKEN"])
	require.Equal(t, "imaustink", stringData["AGENT_ACTOR_LOGIN"])

	_, found, _ = unstructured.NestedMap(obj.Object, "data")
	require.False(t, found)
}

// A refreshed credential must overwrite the stored copy. Reusing a stale one is
// upstream's "Login expired · Please run /login" on every later run.
func TestWriteRunCredentialsOverwritesOnRelaunch(t *testing.T) {
	client := newSecretClient()
	w := NewK8sSecretWriter(client, "ns")

	name, err := w.WriteRunCredentials(context.Background(), "agent-sub", map[string]string{"T": "first"})
	require.NoError(t, err)

	again, err := w.WriteRunCredentials(context.Background(), "agent-sub", map[string]string{"T": "second"})
	require.NoError(t, err)
	require.Equal(t, name, again, "the same run reuses its object rather than littering one per attempt")

	obj, err := client.Resource(secretGVR).Namespace("ns").Get(context.Background(), name, metav1.GetOptions{})
	require.NoError(t, err)
	stringData, _, _ := unstructured.NestedStringMap(obj.Object, "stringData")
	require.Equal(t, "second", stringData["T"])
}

func TestWriteRunCredentialsSkipsAnEmptySet(t *testing.T) {
	w := NewK8sSecretWriter(newSecretClient(), "ns")
	name, err := w.WriteRunCredentials(context.Background(), "agent-sub", nil)
	require.NoError(t, err)
	require.Empty(t, name, "no credentials means no object")
}
