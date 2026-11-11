package agentrun

import (
	"context"
	"fmt"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"github.com/aktisai/orchestrator/engines/temporal/internal/audit"
	"github.com/aktisai/orchestrator/engines/temporal/internal/catalog"
	"github.com/aktisai/orchestrator/engines/temporal/internal/toolrun"
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
	// ReadOnly sets spec.readOnly (AGENT_READ_ONLY=true in the pod; ADR
	// 0048): the SWE agents deny pushes/PR mutations and mint a read-only
	// token from this alone — never from the goal text.
	ReadOnly bool
	// Params sets spec.params (AGENT_PARAMS=<json>): the matched
	// EventTrigger's params in their string form.
	Params map[string]string
	// Launch sets spec.identityMode (AGENT_IDENTITY_MODE) and the immutable
	// spec.launch audit record (docs/adr/0049). Zero sets neither.
	Launch audit.Launch
	// ContentCapture sets spec.contentCapture (docs/adr/0050 §5): "content"
	// lets the run's own telemetry record text. Empty writes nothing.
	ContentCapture string
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
	if spec.ReadOnly {
		crSpec["readOnly"] = true
	}
	if len(spec.Params) > 0 {
		params := make(map[string]any, len(spec.Params))
		for k, v := range spec.Params {
			params[k] = v
		}
		crSpec["params"] = params
	}
	if spec.Launch.IdentityMode != "" {
		crSpec["identityMode"] = spec.Launch.IdentityMode
	}
	if spec.ContentCapture != "" {
		crSpec["contentCapture"] = spec.ContentCapture
	}
	if launch := launchSpec(spec.Launch); launch != nil {
		crSpec["launch"] = launch
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

// launchSpec renders AgentRun.spec.launch (docs/adr/0049 §3) from the
// pre-flight's audit view. Nil when no decision covered this launch.
//
// Built field by field rather than marshalled whole: identityMode is its own
// spec field, readOnly is too, and an unknown key would be pruned by the
// CRD's structural schema anyway, so naming exactly what the CRD has keeps
// the two from drifting silently.
func launchSpec(l audit.Launch) map[string]any {
	if l.DecisionID == "" && l.LaunchedBy == "" {
		return nil
	}
	out := map[string]any{}
	set := func(k, v string) {
		if v != "" {
			out[k] = v
		}
	}
	set("decisionId", l.DecisionID)
	set("entryPoint", l.EntryPoint)
	set("launchedBy", l.LaunchedBy)
	set("delegatedSubject", l.DelegatedSubject)
	set("trigger", l.Trigger)
	set("requestedIdentityMode", l.RequestedIdentityMode)
	set("identityModeSource", l.IdentityModeSource)
	set("targetRepository", l.TargetRepository)
	set("traceId", l.TraceID)
	set("traceparent", l.Traceparent)
	if l.Sender != nil {
		sender := map[string]any{}
		for k, v := range map[string]string{"provider": l.Sender.Provider, "login": l.Sender.Login, "accountId": l.Sender.AccountID} {
			if v != "" {
				sender[k] = v
			}
		}
		if len(sender) > 0 {
			out["sender"] = sender
		}
	}
	if len(l.Credentials) > 0 {
		creds := make([]any, len(l.Credentials))
		for i, c := range l.Credentials {
			entry := map[string]any{"provider": c.Provider}
			if c.Read != "" {
				entry["read"] = c.Read
			}
			if c.Write != "" {
				entry["write"] = c.Write
			}
			creds[i] = entry
		}
		out["credentials"] = creds
	}
	return out
}
