package agentrun

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/toolrun"
)

var GVR = schema.GroupVersionResource{
	Group:    catalog.Group,
	Version:  catalog.Version,
	Resource: "agentruns",
}

// LaunchSpec is one pod-agent episode.
type LaunchSpec struct {
	// Name becomes the AgentRun CR name and the protocol's agent_run_id, so it
	// also determines the NATS subjects. One value ties all three together.
	Name string
	// AgentRef names the Agent CR describing the image and its environment.
	AgentRef string
	// Goal is the initial prompt.
	Goal string
	// CallbackURL is where the Job posts HMAC-signed events. Required by the
	// CRD even for a NATS-driven agent, which reports over its own channel.
	CallbackURL    string
	TimeoutSeconds int32
	// SecretEnv carries caller-scoped credentials by REFERENCE. Values live in
	// the Secret the authorization pre-flight wrote; nothing here is plaintext.
	SecretEnv []toolrun.SecretEnvVar
}

// Launcher creates AgentRun CRs. The core-controller reconciles each into a
// Job, exactly as it does today — this system launches the same resource the
// upstream orchestrator does, which is what lets an unmodified agent image run.
type Launcher interface {
	Launch(ctx context.Context, spec LaunchSpec) error
	GetStatus(ctx context.Context, name string) (toolrun.Status, error)
}

type K8sLauncher struct {
	client    dynamic.Interface
	namespace string
	secretRef toolrun.SecretRef
}

func NewK8sLauncher(client dynamic.Interface, namespace string, secretRef toolrun.SecretRef) *K8sLauncher {
	return &K8sLauncher{client: client, namespace: namespace, secretRef: secretRef}
}

func (l *K8sLauncher) Launch(ctx context.Context, spec LaunchSpec) error {
	if spec.Name == "" || spec.AgentRef == "" || spec.Goal == "" || spec.CallbackURL == "" {
		return fmt.Errorf("launch spec requires name, agentRef, goal, and callbackURL")
	}

	crSpec := map[string]any{
		"agentRef": spec.AgentRef,
		"goal":     spec.Goal,
		"callback": map[string]any{
			"url": spec.CallbackURL,
			"secretRef": map[string]any{
				"name": l.secretRef.Name,
				"key":  l.secretRef.Key,
			},
		},
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

	run := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": catalog.Group + "/" + catalog.Version,
		"kind":       "AgentRun",
		"metadata": map[string]any{
			"name":      spec.Name,
			"namespace": l.namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by": "durable-agents",
			},
		},
		"spec": crSpec,
	}}

	_, err := l.client.Resource(GVR).Namespace(l.namespace).Create(ctx, run, metav1.CreateOptions{})
	if errors.IsAlreadyExists(err) {
		return nil // activity retry after a successful create
	}
	if err != nil {
		return fmt.Errorf("create AgentRun %s (agent %s): %w", spec.Name, spec.AgentRef, err)
	}
	return nil
}

func (l *K8sLauncher) GetStatus(ctx context.Context, name string) (toolrun.Status, error) {
	obj, err := l.client.Resource(GVR).Namespace(l.namespace).Get(ctx, name, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		return toolrun.Status{Message: "AgentRun not found"}, nil
	}
	if err != nil {
		return toolrun.Status{}, fmt.Errorf("get AgentRun %s: %w", name, err)
	}
	phase, _, _ := unstructured.NestedString(obj.Object, "status", "phase")
	message, _, _ := unstructured.NestedString(obj.Object, "status", "message")
	jobName, _, _ := unstructured.NestedString(obj.Object, "status", "jobName")
	return toolrun.Status{Phase: phase, Message: message, JobName: jobName}, nil
}
