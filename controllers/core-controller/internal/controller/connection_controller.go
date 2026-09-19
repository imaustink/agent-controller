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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const connectionConditionReady = "Ready"

// ConnectionCollectionName is the vector-store collection a Connection owns.
//
// Storage is per-Connection rather than per-KnowledgeBase (ADR 0039 §1), so a
// Connection shared by several knowledge bases is embedded once and recomposing
// a knowledge base costs no re-indexing.
//
// Namespace and name both appear because collections are global in the vector
// store while Connection names are only unique per namespace. Without the
// namespace, two same-named Connections in different namespaces would silently
// share one collection — a cross-tenant leak of exactly the kind ADR 0039 §1
// argues the per-collection split exists to prevent.
func ConnectionCollectionName(namespace, name string) string {
	return fmt.Sprintf("conn_%s_%s", namespace, name)
}

// ConnectionReconciler reconciles a Connection object
type ConnectionReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections/finalizers,verbs=update

// Reconcile assigns a Connection its vector-store collection and reports
// readiness.
//
// Deliberately narrow, for two reasons.
//
// The spec's own invariants — provider/scope agreement, and a reconcile
// interval whenever sync is enabled — are CEL rules on the CRD (ADR 0038), so
// they are rejected at admission and never reach a reconcile. Re-checking them
// here would duplicate an enforcement that already fails closed.
//
// And credential presence is deliberately NOT validated. This controller holds
// no RBAC on Secrets at all: it injects secretEnv into a Job by reference and
// lets the kubelet resolve it, so no secret value ever enters the controller.
// Confirming that a referenced Secret exists would mean granting read over
// Secrets cluster-wide, which is a real privilege increase to buy a nicety —
// a missing credential surfaces as a failed sync instead.
//
// Syncing itself belongs to the connection-broker and its sync worker, neither
// of which exists yet; this reconciler does not schedule work it cannot run.
func (r *ConnectionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var connection corev1alpha1.Connection
	if err := r.Get(ctx, req.NamespacedName, &connection); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	collection := ConnectionCollectionName(connection.Namespace, connection.Name)
	if connection.Status.Collection != collection {
		log.Info("Assigned Connection a vector-store collection",
			"connection", connection.Name, "collection", collection)
	}
	connection.Status.Collection = collection
	connection.Status.ObservedGeneration = connection.Generation

	meta.SetStatusCondition(&connection.Status.Conditions, metav1.Condition{
		Type:               connectionConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "Accepted",
		Message:            fmt.Sprintf("scoped %s connection; indexes into %s", connection.Spec.Provider, collection),
		ObservedGeneration: connection.Generation,
	})

	if err := r.Status().Update(ctx, &connection); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *ConnectionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Connection{}).
		Named("connection").
		Complete(r)
}
