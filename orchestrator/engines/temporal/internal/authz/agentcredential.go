package authz

import (
	"context"
	"encoding/base64"
	"fmt"

	"k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
)

// ToolIdentityAgent is the Tool/MCPTool defaultIdentity that presents the
// operator's own credential instead of the caller's (docs/adr/0049 step 5).
const ToolIdentityAgent = "agent"

// AgentCredentialSecretLabel must be "true" on a Secret an IdentityProvider's
// agentCredential names. Mirrors the core-controller API constant: the Secret's
// owner opting in is what stops an IdentityProvider alone from naming any
// Secret in the namespace and having the engine copy it into a tool Job.
const AgentCredentialSecretLabel = "core.aktis.ai/agent-credential"

// AgentCredential is an operator's credential for one provider. Value is
// credential material: it goes straight into a run's Secret or an MCP call's
// header and never into a verdict, log line or workflow payload.
type AgentCredential struct {
	// EnvVar is the IdentityProvider's spec.envVar.
	EnvVar string
	Value  string
}

// AgentCredentialSource resolves IdentityProvider.spec.agentCredential.
// (nil, nil) means the provider has none configured.
type AgentCredentialSource interface {
	AgentCredential(ctx context.Context, provider string) (*AgentCredential, error)
}

var identityProviderGVR = schema.GroupVersionResource{Group: "core.aktis.ai", Version: "v1alpha1", Resource: "identityproviders"}

// K8sAgentCredentials reads an IdentityProvider and the Secret its
// agentCredential names, on demand. Tool calls in agent identity are rare
// enough that a get per call is cheaper than another informer, and a get
// always sees a rotated Secret.
type K8sAgentCredentials struct {
	client    dynamic.Interface
	namespace string
}

func NewK8sAgentCredentials(client dynamic.Interface, namespace string) *K8sAgentCredentials {
	return &K8sAgentCredentials{client: client, namespace: namespace}
}

func (k *K8sAgentCredentials) AgentCredential(ctx context.Context, provider string) (*AgentCredential, error) {
	idp, err := k.client.Resource(identityProviderGVR).Namespace(k.namespace).Get(ctx, provider, metav1.GetOptions{})
	if errors.IsNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read IdentityProvider %q: %w", provider, err)
	}
	envVar, _, _ := unstructured.NestedString(idp.Object, "spec", "envVar")
	name, _, _ := unstructured.NestedString(idp.Object, "spec", "agentCredential", "secretRef", "name")
	key, _, _ := unstructured.NestedString(idp.Object, "spec", "agentCredential", "secretRef", "key")
	if name == "" || key == "" {
		return nil, nil
	}

	secret, err := k.client.Resource(secretGVR).Namespace(k.namespace).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		return nil, fmt.Errorf("read the agentCredential Secret %q of IdentityProvider %q: %w", name, provider, err)
	}
	if secret.GetLabels()[AgentCredentialSecretLabel] != "true" {
		return nil, fmt.Errorf("the agentCredential Secret %q of IdentityProvider %q is not labelled %s=true", name, provider, AgentCredentialSecretLabel)
	}
	encoded, _, _ := unstructured.NestedString(secret.Object, "data", key)
	value, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(value) == 0 {
		return nil, fmt.Errorf("the agentCredential Secret %q of IdentityProvider %q has no usable key %q", name, provider, key)
	}
	return &AgentCredential{EnvVar: envVar, Value: string(value)}, nil
}

// agentCredential resolves one provider's agent credential for a tool call,
// as a misconfiguration message when there is none to use: an agent-identity
// tool whose provider has no agentCredential cannot be fixed by the caller.
func (s *Service) agentCredential(ctx context.Context, provider string) (*AgentCredential, string) {
	if s.deps.AgentCredentials == nil {
		return nil, "no agent-credential source is configured"
	}
	cred, err := s.deps.AgentCredentials.AgentCredential(ctx, provider)
	if err != nil {
		return nil, err.Error()
	}
	if cred == nil {
		return nil, fmt.Sprintf("IdentityProvider %q has no agentCredential", provider)
	}
	if cred.EnvVar == "" {
		cred.EnvVar = ProviderEnvVar[provider]
	}
	if known := ProviderEnvVar[provider]; known != "" {
		// A provider this engine knows keeps its fixed env var, so a tool
		// reads the same variable whichever identity it runs with.
		cred.EnvVar = known
	}
	if cred.EnvVar == "" {
		return nil, fmt.Sprintf("IdentityProvider %q has no envVar", provider)
	}
	return cred, ""
}
