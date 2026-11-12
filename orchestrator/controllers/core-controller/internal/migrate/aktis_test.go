package migrate

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/kubernetes/fake"
)

func nolog(string, ...any) {}

func TestRewriteKey(t *testing.T) {
	cases := map[string]string{
		"controller-agent.dev/credential":    "aktis.ai/credential",
		"run.controller-agent.dev/agent":     "run.aktis.ai/agent",
		"controller-agent.io/subject":        "aktis.ai/subject",
		"app.kubernetes.io/name":             "app.kubernetes.io/name",
		"meta.helm.sh/release-name":          "meta.helm.sh/release-name",
		"no-slash":                           "no-slash",
		"sub.controller-agent.io/not-the-io": "sub.controller-agent.io/not-the-io",
	}
	for in, want := range cases {
		if got := RewriteKey(in); got != want {
			t.Errorf("RewriteKey(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestRelabelAddsNewKeysAndKeepsExisting(t *testing.T) {
	ctx := context.Background()
	cs := fake.NewClientset(
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "identity-link-github-abc", Namespace: "ns",
			Labels: map[string]string{
				"controller-agent.dev/credential": "identity-link",
				"controller-agent.dev/subject":    "openwebui-1",
				"app.kubernetes.io/part-of":       "x",
			},
			Annotations: map[string]string{"controller-agent.io/linked-at": "t"},
		}},
		// The new release already wrote the new key: it must win.
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "both", Namespace: "ns",
			Labels: map[string]string{
				"controller-agent.dev/subject": "old",
				"aktis.ai/subject":             "new",
			},
		}},
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "unrelated", Namespace: "ns"}},
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{
			Name: "cm", Namespace: "ns",
			Labels: map[string]string{"controller-agent.dev/kind": "k"},
		}},
		// Outside the listed namespaces: untouched.
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{
			Name: "elsewhere", Namespace: "other",
			Labels: map[string]string{"controller-agent.dev/credential": "c"},
		}},
	)

	n, err := Relabel(ctx, cs, []string{"ns"}, nolog)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("patched %d objects, want 2 (the link secret and the configmap)", n)
	}

	s, _ := cs.CoreV1().Secrets("ns").Get(ctx, "identity-link-github-abc", metav1.GetOptions{})
	for k, v := range map[string]string{
		"aktis.ai/credential":             "identity-link",
		"aktis.ai/subject":                "openwebui-1",
		"controller-agent.dev/credential": "identity-link", // old keys stay for rollback
	} {
		if s.Labels[k] != v {
			t.Errorf("label %s = %q, want %q", k, s.Labels[k], v)
		}
	}
	if s.Annotations["aktis.ai/linked-at"] != "t" {
		t.Errorf("annotation not relabelled: %v", s.Annotations)
	}

	both, _ := cs.CoreV1().Secrets("ns").Get(ctx, "both", metav1.GetOptions{})
	if both.Labels["aktis.ai/subject"] != "new" {
		t.Errorf("existing aktis.ai key overwritten: %q", both.Labels["aktis.ai/subject"])
	}

	cm, _ := cs.CoreV1().ConfigMaps("ns").Get(ctx, "cm", metav1.GetOptions{})
	if cm.Labels["aktis.ai/kind"] != "k" {
		t.Errorf("configmap not relabelled: %v", cm.Labels)
	}

	other, _ := cs.CoreV1().Secrets("other").Get(ctx, "elsewhere", metav1.GetOptions{})
	if _, ok := other.Labels["aktis.ai/credential"]; ok {
		t.Error("relabelled a secret outside the listed namespaces")
	}

	// Idempotent: a second run changes nothing.
	if n, err := Relabel(ctx, cs, []string{"ns"}, nolog); err != nil || n != 0 {
		t.Fatalf("second run patched %d (err %v), want 0", n, err)
	}
}

func oldCR(kind, ns, name string, finalizers ...string) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion(OldGroup + "/" + Version)
	u.SetKind(kind)
	u.SetNamespace(ns)
	u.SetName(name)
	u.SetFinalizers(finalizers)
	return u
}

func TestStripOldFinalizers(t *testing.T) {
	ctx := context.Background()
	listKinds := map[schema.GroupVersionResource]string{}
	for _, p := range OldPlurals {
		listKinds[schema.GroupVersionResource{Group: OldGroup, Version: Version, Resource: p}] = p + "List"
	}
	dyn := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), listKinds,
		oldCR("Connection", "kb", "conf",
			"controller-agent.dev/corpora-exist", "example.com/keep"),
		oldCR("AgentRun", "ac", "run-1", "run.controller-agent.dev/cleanup"),
		oldCR("Agent", "ac", "plain"),
	)

	n, err := StripOldFinalizers(ctx, dyn, nolog)
	if err != nil {
		t.Fatal(err)
	}
	if n != 2 {
		t.Fatalf("patched %d, want 2", n)
	}

	conn, _ := dyn.Resource(schema.GroupVersionResource{Group: OldGroup, Version: Version, Resource: "connections"}).
		Namespace("kb").Get(ctx, "conf", metav1.GetOptions{})
	if got := conn.GetFinalizers(); len(got) != 1 || got[0] != "example.com/keep" {
		t.Errorf("connection finalizers = %v, want only the foreign one kept", got)
	}
	run, _ := dyn.Resource(schema.GroupVersionResource{Group: OldGroup, Version: Version, Resource: "agentruns"}).
		Namespace("ac").Get(ctx, "run-1", metav1.GetOptions{})
	if got := run.GetFinalizers(); len(got) != 0 {
		t.Errorf("agentrun finalizers = %v, want none", got)
	}

	if n, err := StripOldFinalizers(ctx, dyn, nolog); err != nil || n != 0 {
		t.Fatalf("second run patched %d (err %v), want 0", n, err)
	}
}
