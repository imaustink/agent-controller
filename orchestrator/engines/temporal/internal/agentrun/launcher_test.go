package agentrun_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"

	"github.com/controller-agent/temporal-engine/internal/agentrun"
	"github.com/controller-agent/temporal-engine/internal/toolrun"
)

// readOnly and params are structured CR fields (ADR 0048) — what the SWE
// agents read their write-gate from, instead of a sentinel in the goal. A run
// that is not read-only carries neither, byte-identical to before.
func TestLaunchCarriesReadOnlyAndParams(t *testing.T) {
	for _, tc := range []struct {
		name     string
		readOnly bool
		params   map[string]string
	}{
		{"read-only with params", true, map[string]string{"repo": "acme/widgets", "number": "42"}},
		{"ordinary", false, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(),
				map[schema.GroupVersionResource]string{agentrun.GVR: "AgentRunList"})
			launcher := agentrun.NewK8sLauncher(client, "ns", toolrun.SecretRef{Name: "cb", Key: "k"})
			require.NoError(t, launcher.Launch(context.Background(), agentrun.LaunchSpec{
				Name: "agentrun-swe-1", AgentRef: "swe", Goal: "Review acme/widgets#42",
				CallbackURL: "http://gw/callback/w/agentrun-swe-1",
				ReadOnly:    tc.readOnly, Params: tc.params,
			}))

			obj, err := client.Resource(agentrun.GVR).Namespace("ns").Get(context.Background(), "agentrun-swe-1", metav1.GetOptions{})
			require.NoError(t, err)
			readOnly, found, _ := unstructured.NestedBool(obj.Object, "spec", "readOnly")
			require.Equal(t, tc.readOnly, found, "readOnly is written only when true")
			require.Equal(t, tc.readOnly, readOnly)
			params, found, _ := unstructured.NestedStringMap(obj.Object, "spec", "params")
			require.Equal(t, tc.params != nil, found)
			if tc.params != nil {
				require.Equal(t, tc.params, params)
			}
		})
	}
}
