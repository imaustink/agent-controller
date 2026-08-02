package toolrun

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"durable-agents/internal/catalog"
)

var ToolRunGVR = schema.GroupVersionResource{
	Group:    catalog.Group,
	Version:  catalog.Version,
	Resource: "toolruns",
}

// SecretRef points at the HMAC callback secret in the ToolRun's namespace;
// the controller injects it into the Job as RECIPE_CALLBACK_SECRET. The
// gateway must hold the same secret value to verify signatures.
type SecretRef struct {
	Name string
	Key  string
}

type K8sLauncher struct {
	client    dynamic.Interface
	namespace string
	secretRef SecretRef
}

func NewK8sLauncher(client dynamic.Interface, namespace string, secretRef SecretRef) *K8sLauncher {
	return &K8sLauncher{client: client, namespace: namespace, secretRef: secretRef}
}

func (l *K8sLauncher) Launch(ctx context.Context, spec LaunchSpec) error {
	if spec.Name == "" || spec.ToolRef == "" || spec.CallbackURL == "" {
		return fmt.Errorf("launch spec requires name, toolRef, and callbackURL")
	}

	crSpec := map[string]any{
		"toolRef": spec.ToolRef,
		"callback": map[string]any{
			"url": spec.CallbackURL,
			"secretRef": map[string]any{
				"name": l.secretRef.Name,
				"key":  l.secretRef.Key,
			},
		},
	}
	if len(spec.Args) > 0 {
		args := make([]any, len(spec.Args))
		for i, a := range spec.Args {
			args[i] = a
		}
		crSpec["args"] = args
	}
	if spec.TimeoutSeconds > 0 {
		crSpec["timeoutSeconds"] = int64(spec.TimeoutSeconds)
	}
	if len(spec.SecretEnv) > 0 {
		entries := make([]any, len(spec.SecretEnv))
		for i, e := range spec.SecretEnv {
			if e.Name == "" || e.SecretRef.Name == "" || e.SecretRef.Key == "" {
				return fmt.Errorf("launch %s: secretEnv[%d] requires name and secretRef.name/key", spec.Name, i)
			}
			entries[i] = map[string]any{
				"name": e.Name,
				"secretRef": map[string]any{
					"name": e.SecretRef.Name,
					"key":  e.SecretRef.Key,
				},
			}
		}
		crSpec["secretEnv"] = entries
	}

	toolRun := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": catalog.Group + "/" + catalog.Version,
		"kind":       "ToolRun",
		"metadata": map[string]any{
			"name":      spec.Name,
			"namespace": l.namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by": "durable-agents",
			},
		},
		"spec": crSpec,
	}}

	_, err := l.client.Resource(ToolRunGVR).Namespace(l.namespace).Create(ctx, toolRun, metav1.CreateOptions{})
	if errors.IsAlreadyExists(err) {
		return nil // activity retry after a successful create
	}
	if err != nil {
		return fmt.Errorf("create ToolRun %s (tool %s): %w", spec.Name, spec.ToolRef, err)
	}
	return nil
}

func (l *K8sLauncher) GetStatus(ctx context.Context, name string) (Status, error) {
	obj, err := l.client.Resource(ToolRunGVR).Namespace(l.namespace).Get(ctx, name, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		return Status{Phase: "", Message: "ToolRun not found"}, nil
	}
	if err != nil {
		return Status{}, fmt.Errorf("get ToolRun %s: %w", name, err)
	}

	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	message, _, _ := unstructured.NestedString(obj.Object, "status", "message")
	jobName, _, _ := unstructured.NestedString(obj.Object, "status", "jobName")
	return Status{Phase: phase, Message: message, JobName: jobName}, nil
}
