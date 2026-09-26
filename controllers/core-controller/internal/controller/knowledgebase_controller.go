/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

package controller

import (
	"context"
	"fmt"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const knowledgeBaseConditionReady = "Ready"

// staleGraceFactor is how far past its own reconcileInterval a Corpus may
// drift before the knowledge base calls it stale.
//
// Two intervals rather than one: a reconcile that starts on time but takes a
// while, or a single missed pass, is normal operation. Flagging at 1x would
// flap on every ordinary run and train people to ignore the field, which
// matters because staleness is meant to be surfaced in cited answers.
const staleGraceFactor = 2

// KnowledgeBaseReconciler reconciles a KnowledgeBase object
type KnowledgeBaseReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=knowledgebases,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=knowledgebases/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=knowledgebases/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections,verbs=get;list;watch

// Reconcile resolves a KnowledgeBase's connectionRefs and aggregates what its
// members report, so one read of the knowledge base answers "what is in here,
// and how much of it is current?".
//
// Both failure modes it reports are ones that otherwise degrade silently. A
// dangling ref means the knowledge base answers from less than it claims to
// cover; a stale member means it answers from material that has moved on. Both
// produce a confident answer built on an incomplete corpus, which is the
// failure a knowledge base exists to prevent — so both are surfaced in status
// rather than left for someone to notice.
//
// This is a static-config check, not an authorization boundary. The audience
// derivation (a UNION over members, ADR 0039 §4) belongs to the orchestrator's
// indexer alongside the rest of skill access derivation, and per-chunk role
// filtering at the vector store is what actually decides what a caller sees.
func (r *KnowledgeBaseReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var kb corev1alpha1.KnowledgeBase
	if err := r.Get(ctx, req.NamespacedName, &kb); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	var (
		missing   []string
		stale     []string
		perCorpus []corev1alpha1.KnowledgeBaseCorpusStatus
		documents int64
	)

	for _, ref := range kb.Spec.CorpusRefs {
		var conn corev1alpha1.Corpus
		key := types.NamespacedName{Namespace: kb.Namespace, Name: ref}
		if err := r.Get(ctx, key, &conn); err != nil {
			if !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			missing = append(missing, ref)
			continue
		}

		documents += conn.Status.Resources
		perCorpus = append(perCorpus, corev1alpha1.KnowledgeBaseCorpusStatus{
			Name:         conn.Name,
			Documents:    conn.Status.Resources,
			LastSyncTime: conn.Status.LastSyncTime,
		})

		if corpusIsStale(&conn, time.Now()) {
			stale = append(stale, conn.Name)
		}
	}

	kb.Status.Documents = documents
	kb.Status.PerCorpus = perCorpus
	kb.Status.MissingCorpora = missing
	kb.Status.StaleCorpora = stale
	kb.Status.ObservedGeneration = kb.Generation

	condition := metav1.Condition{
		Type:               knowledgeBaseConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "RefsResolved",
		Message:            fmt.Sprintf("%d connections resolved", len(perCorpus)),
		ObservedGeneration: kb.Generation,
	}
	if len(missing) > 0 {
		condition.Status = metav1.ConditionFalse
		condition.Reason = "RefsMissing"
		condition.Message = fmt.Sprintf("connectionRefs not found: %v", missing)
		log.Info("KnowledgeBase references missing Corpora",
			"knowledgeBase", kb.Name, "missing", missing)
	}
	meta.SetStatusCondition(&kb.Status.Conditions, condition)

	if err := r.Status().Update(ctx, &kb); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

// connectionIsStale reports whether a syncing Corpus has missed its
// reconcile window by more than the grace factor.
//
// lastReconcileTime, not lastSyncTime: the full reconcile is the source of
// truth (ADR 0038 §4), so a Corpus kept warm by webhook deliveries is still
// stale if it has not reconciled — webhook streams are lossy, and a corpus that
// looks fresh because events kept arriving is exactly the quiet wrongness the
// reconcile backstop exists to catch.
//
// A Corpus that syncs but has never reconciled is stale by definition.
func corpusIsStale(conn *corev1alpha1.Corpus, now time.Time) bool {
	sync := conn.Spec.Sync
	if sync == nil || sync.Mode == corev1alpha1.CorpusSyncNone {
		return false // indexes nothing, so it cannot be out of date
	}
	if sync.ReconcileInterval == nil {
		return false // CEL requires one whenever mode != none; nothing to judge against
	}
	if conn.Status.LastReconcileTime == nil {
		return true
	}
	deadline := conn.Status.LastReconcileTime.Add(staleGraceFactor * sync.ReconcileInterval.Duration)
	return now.After(deadline)
}

// SetupWithManager sets up the controller with the Manager.
//
// Watching Corpora matters as much as watching KnowledgeBases: a member's
// sync status is most of what this controller reports, so without it a
// knowledge base's view of its own freshness would only update when the
// KnowledgeBase itself changed — which is almost never.
func (r *KnowledgeBaseReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.KnowledgeBase{}).
		Watches(
			&corev1alpha1.Corpus{},
			handler.EnqueueRequestsFromMapFunc(r.knowledgeBasesForCorpus),
		).
		Named("knowledgebase").
		Complete(r)
}

// knowledgeBasesForCorpus maps a changed Corpus to every KnowledgeBase
// that composes it — many-to-many by design, since one shared Corpus (an
// announcements channel, say) is context for several clients.
func (r *KnowledgeBaseReconciler) knowledgeBasesForCorpus(ctx context.Context, obj client.Object) []reconcile.Request {
	var list corev1alpha1.KnowledgeBaseList
	if err := r.List(ctx, &list, client.InNamespace(obj.GetNamespace())); err != nil {
		logf.FromContext(ctx).Error(err, "Could not list KnowledgeBases for changed Corpus",
			"connection", obj.GetName())
		return nil
	}

	var requests []reconcile.Request
	for _, kb := range list.Items {
		for _, ref := range kb.Spec.CorpusRefs {
			if ref != obj.GetName() {
				continue
			}
			requests = append(requests, reconcile.Request{
				NamespacedName: types.NamespacedName{Namespace: kb.Namespace, Name: kb.Name},
			})
			break
		}
	}
	return requests
}
