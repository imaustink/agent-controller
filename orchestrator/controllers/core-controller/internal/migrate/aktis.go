// Package migrate holds the in-cluster half of the Aktis rename (ADR 0047 §6,
// docs/aktis-migration.md): the steps a chart upgrade cannot express as
// manifests, run as a post-install/post-upgrade hook Job so a GitOps
// deployment migrates with no hand-applied cluster changes.
//
// The release itself does the declarative part: the new chart ships the
// core.aktis.ai CRDs, and Argo CD (or Helm) prunes the old-group objects the
// old chart owned. Two things are left that no manifest can say:
//
//   - Credential Secrets (and ConfigMaps) are written at runtime and found by
//     label selector. Ones written by the old release carry only the
//     controller-agent.dev/.io keys, so the new release cannot see them and
//     every linked account would vanish. Relabel adds the aktis.ai key next to
//     each old one; it never overwrites an aktis.ai key that is already there.
//   - Old-group CRs carry finalizers (e.g. corpora-exist on a Connection) that
//     only the old controller served. Once the old CRDs are pruned those CRs
//     sit in Terminating forever, and so does the CRD. StripOldFinalizers
//     removes the old-domain finalizers so the prune completes.
//
// Both steps are idempotent and no-ops on a cluster that never ran the old
// group, so the hook is safe on every install and sync.
package migrate

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

const (
	OldGroup = "core.controller-agent.dev"
	Version  = "v1alpha1"
)

// OldPlurals is every resource the old group ever served, including the
// runtime records and the retired IntegrationRoute (ADR 0048).
var OldPlurals = []string{
	"agents", "tools", "skills", "localtools", "identityproviders", "eventsources",
	"eventtriggers", "connections", "corpora", "knowledgebases", "mcpservers",
	"agentruns", "toolruns", "mcptools", "integrationroutes",
}

var oldKeyRE = regexp.MustCompile(`^([a-z0-9.-]*\.)?controller-agent\.dev/|^controller-agent\.io/`)

// IsOldKey reports whether a label/annotation/finalizer key is in one of the
// pre-Aktis domains.
func IsOldKey(k string) bool { return oldKeyRE.MatchString(k) }

// RewriteKey maps an old-domain key to its aktis.ai equivalent, keeping any
// subdomain prefix (run.controller-agent.dev/x -> run.aktis.ai/x). Keys outside
// the old domains are returned unchanged.
func RewriteKey(k string) string {
	domain, rest, ok := strings.Cut(k, "/")
	if !ok {
		return k
	}
	switch {
	case domain == "controller-agent.io":
		domain = "aktis.ai"
	case strings.HasSuffix(domain, "controller-agent.dev"):
		domain = strings.TrimSuffix(domain, "controller-agent.dev") + "aktis.ai"
	default:
		return k
	}
	return domain + "/" + rest
}

// newKeys returns the aktis.ai keys to add to m: one per old key whose new key
// is absent. A new key already present wins, because the new release wrote it.
func newKeys(m map[string]string) map[string]string {
	add := map[string]string{}
	for k, v := range m {
		if !IsOldKey(k) {
			continue
		}
		nk := RewriteKey(k)
		if _, exists := m[nk]; !exists {
			add[nk] = v
		}
	}
	return add
}

func relabelPatch(labels, annotations map[string]string) ([]byte, bool) {
	l, a := newKeys(labels), newKeys(annotations)
	if len(l) == 0 && len(a) == 0 {
		return nil, false
	}
	meta := map[string]any{}
	if len(l) > 0 {
		meta["labels"] = l
	}
	if len(a) > 0 {
		meta["annotations"] = a
	}
	b, _ := json.Marshal(map[string]any{"metadata": meta})
	return b, true
}

// Logf is how the steps report what they changed.
type Logf func(format string, args ...any)

// Relabel adds the aktis.ai keys to every Secret and ConfigMap in namespaces
// that carries only the old ones. It returns how many objects it patched.
func Relabel(ctx context.Context, cs kubernetes.Interface, namespaces []string, logf Logf) (int, error) {
	n := 0
	for _, ns := range namespaces {
		secrets, err := cs.CoreV1().Secrets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return n, fmt.Errorf("list secrets in %s: %w", ns, err)
		}
		for _, s := range secrets.Items {
			p, ok := relabelPatch(s.Labels, s.Annotations)
			if !ok {
				continue
			}
			if _, err := cs.CoreV1().Secrets(ns).Patch(ctx, s.Name, types.MergePatchType, p, metav1.PatchOptions{}); err != nil {
				return n, fmt.Errorf("relabel secret %s/%s: %w", ns, s.Name, err)
			}
			logf("relabelled secret %s/%s", ns, s.Name)
			n++
		}
		cms, err := cs.CoreV1().ConfigMaps(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return n, fmt.Errorf("list configmaps in %s: %w", ns, err)
		}
		for _, c := range cms.Items {
			p, ok := relabelPatch(c.Labels, c.Annotations)
			if !ok {
				continue
			}
			if _, err := cs.CoreV1().ConfigMaps(ns).Patch(ctx, c.Name, types.MergePatchType, p, metav1.PatchOptions{}); err != nil {
				return n, fmt.Errorf("relabel configmap %s/%s: %w", ns, c.Name, err)
			}
			logf("relabelled configmap %s/%s", ns, c.Name)
			n++
		}
	}
	return n, nil
}

// StripOldFinalizers removes old-domain finalizers from every old-group CR in
// the cluster, so pruning the old CRDs can complete. A resource whose CRD is
// already gone is skipped. It returns how many objects it patched.
func StripOldFinalizers(ctx context.Context, dyn dynamic.Interface, logf Logf) (int, error) {
	n := 0
	for _, plural := range OldPlurals {
		gvr := schema.GroupVersionResource{Group: OldGroup, Version: Version, Resource: plural}
		list, err := dyn.Resource(gvr).List(ctx, metav1.ListOptions{})
		if err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return n, fmt.Errorf("list %s.%s: %w", plural, OldGroup, err)
		}
		for _, obj := range list.Items {
			fins := obj.GetFinalizers()
			keep := make([]string, 0, len(fins))
			for _, f := range fins {
				if !IsOldKey(f) {
					keep = append(keep, f)
				}
			}
			if len(keep) == len(fins) {
				continue
			}
			// A JSON patch with a test op, so a concurrent finalizer change
			// fails this patch instead of being clobbered; the next sync retries.
			p, _ := json.Marshal([]map[string]any{
				{"op": "test", "path": "/metadata/finalizers", "value": fins},
				{"op": "replace", "path": "/metadata/finalizers", "value": keep},
			})
			if _, err := dyn.Resource(gvr).Namespace(obj.GetNamespace()).Patch(ctx, obj.GetName(), types.JSONPatchType, p, metav1.PatchOptions{}); err != nil {
				if apierrors.IsNotFound(err) {
					continue
				}
				return n, fmt.Errorf("strip finalizers on %s %s/%s: %w", plural, obj.GetNamespace(), obj.GetName(), err)
			}
			logf("stripped old finalizers from %s %s/%s", plural, obj.GetNamespace(), obj.GetName())
			n++
		}
	}
	return n, nil
}
