package authz

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	stderrors "errors"
	"fmt"
	"log"
	"strings"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

var secretGVR = schema.GroupVersionResource{Version: "v1", Resource: "secrets"}

// K8sSecretWriter persists a run's resolved credentials into a Kubernetes
// Secret and returns its name.
//
// This is the only code in the system that handles a credential value, and it
// exists so nothing else has to: the pre-flight resolves, this writes, the
// launcher references, and the kubelet reads. No workflow, prompt, log line, or
// Temporal payload sees plaintext.
//
// The object carries no ownerReference of its own — the launcher adopts it once
// the ToolRun/AgentRun exists and has a uid, which is what makes Kubernetes
// reclaim it with the run instead of leaving one behind per launch. That
// ordering (create, then adopt) is forced by the CR not existing yet at
// resolution time.
type K8sSecretWriter struct {
	client    dynamic.Interface
	namespace string
}

func NewK8sSecretWriter(client dynamic.Interface, namespace string) *K8sSecretWriter {
	return &K8sSecretWriter{client: client, namespace: namespace}
}

// secretName derives a DNS-1123-safe name from a run id.
//
// Run ids contain colons (subjects like openwebui:1234 and IdP `sub`s), which
// are illegal in an object name, and are of unbounded length. Hashing keeps
// every read an exact get with no listing, at the cost of a name that does not
// identify its owner — so the readable part is kept as a prefix where it fits.
// Same trade-off, and the same reasoning, as upstream ADR 0034's record keys.
func secretName(runID string) string {
	sum := sha256.Sum256([]byte(runID))
	digest := hex.EncodeToString(sum[:])[:16]

	safe := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '-'
		}
	}, runID)
	safe = strings.Trim(safe, "-")
	if len(safe) > 40 {
		safe = strings.Trim(safe[:40], "-")
	}
	if safe == "" {
		return "run-creds-" + digest
	}
	return safe + "-creds-" + digest
}

func (w *K8sSecretWriter) WriteRunCredentials(ctx context.Context, runID string, data map[string]string) (string, error) {
	if len(data) == 0 {
		return "", nil
	}
	name := secretName(runID)

	stringData := make(map[string]any, len(data))
	for k, v := range data {
		stringData[k] = v
	}

	secret := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "v1",
		"kind":       "Secret",
		"metadata": map[string]any{
			"name":      name,
			"namespace": w.namespace,
			"labels": map[string]any{
				"app.kubernetes.io/managed-by": "durable-agents",
				"durable-agents.dev/purpose":   "run-credentials",
			},
		},
		"type": "Opaque",
		// stringData, not data: the API server base64-encodes it, so nothing
		// here has to, and no encoded credential passes through this process's
		// own formatting paths.
		"stringData": stringData,
	}}

	secrets := w.client.Resource(secretGVR).Namespace(w.namespace)
	_, err := secrets.Create(ctx, secret, metav1.CreateOptions{})
	if errors.IsAlreadyExists(err) {
		// A retried activity, or the same caller launching the same agent
		// again. Update rather than reuse: the credential may have been
		// refreshed since, and serving a stale copy is upstream's
		// "Login expired" failure.
		if _, err = secrets.Update(ctx, secret, metav1.UpdateOptions{}); err != nil {
			return "", fmt.Errorf("update run credential secret: %w", err)
		}
		return name, nil
	}
	if err != nil {
		// Deliberately does not wrap the object: an error string is a log line
		// waiting to happen, and this one would carry stringData.
		return "", fmt.Errorf("create run credential secret: %w", stripped(err))
	}
	return name, nil
}

// stripped keeps an API error's shape without its request body, which for a
// Secret create is every credential the run was about to receive.
func stripped(err error) error {
	var status errors.APIStatus
	if stderrors.As(err, &status) {
		if reason := status.Status().Reason; reason != "" {
			return fmt.Errorf("apiserver rejected the write: %s", reason)
		}
		return fmt.Errorf("apiserver rejected the write with status %d", status.Status().Code)
	}
	// A transport-level failure. Its message is not known to be free of the
	// request body, so it is logged here and not propagated.
	log.Printf("[authorization] secret write failed (non-status error, detail withheld from the verdict)")
	return fmt.Errorf("secret write failed")
}
