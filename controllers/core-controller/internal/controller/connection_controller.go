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
	"slices"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const connectionConditionReady = "Ready"

// connectionFinalizer holds a Connection open while Corpora still draw from it.
const connectionFinalizer = "core.controller-agent.dev/corpora-exist"

// ConnectionReconciler reconciles a Connection object
type ConnectionReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=corpora,verbs=get;list;watch

// Reconcile counts what draws from this Connection, and refuses to let it
// vanish underneath them.
//
// A Connection holds an address and a credential (ADR 0043); the material lives
// in the Corpora that reference it. Deleting one while Corpora remain would
// strand them — every sync and probe failing with no credential to run on — so
// deletion BLOCKS instead of cascading.
//
// Blocking rather than cascading is the deliberate half. Cascading would
// destroy indexed material as a side effect of removing a credential, and those
// are two decisions a person should get to make separately: rotating a
// credential and discarding a client's corpus are not the same intent, and one
// of them is not reversible.
func (r *ConnectionReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var connection corev1alpha1.Connection
	if err := r.Get(ctx, req.NamespacedName, &connection); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	dependents, err := r.dependentCorpora(ctx, &connection)
	if err != nil {
		return ctrl.Result{}, err
	}

	if !connection.DeletionTimestamp.IsZero() {
		if len(dependents) > 0 {
			// Deliberately does not requeue on a timer: removing the last
			// Corpus triggers a watch, which is the only event that can change
			// this answer.
			log.Info("Refusing to delete Connection while Corpora reference it",
				"connection", connection.Name, "corpora", len(dependents))
			connection.Status.Corpora = int64(len(dependents))
			meta.SetStatusCondition(&connection.Status.Conditions, metav1.Condition{
				Type:    connectionConditionReady,
				Status:  metav1.ConditionFalse,
				Reason:  "CorporaExist",
				Message: fmt.Sprintf("deletion blocked: %d corpus/corpora still draw from this connection (%v); delete them first", len(dependents), dependents),
			})
			return ctrl.Result{}, r.Status().Update(ctx, &connection)
		}

		controllerutil.RemoveFinalizer(&connection, connectionFinalizer)
		return ctrl.Result{}, r.Update(ctx, &connection)
	}

	if controllerutil.AddFinalizer(&connection, connectionFinalizer) {
		if err := r.Update(ctx, &connection); err != nil {
			return ctrl.Result{}, err
		}
	}

	connection.Status.Corpora = int64(len(dependents))
	connection.Status.ObservedGeneration = connection.Generation
	meta.SetStatusCondition(&connection.Status.Conditions, metav1.Condition{
		Type:               connectionConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "Accepted",
		Message:            fmt.Sprintf("%s connection serving %d corpus/corpora", connection.Spec.Provider, len(dependents)),
		ObservedGeneration: connection.Generation,
	})

	if err := r.Status().Update(ctx, &connection); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// dependentCorpora names the Corpora drawing from this Connection, sorted so a
// status message does not churn between reconciles.
func (r *ConnectionReconciler) dependentCorpora(
	ctx context.Context,
	connection *corev1alpha1.Connection,
) ([]string, error) {
	var corpora corev1alpha1.CorpusList
	if err := r.List(ctx, &corpora, client.InNamespace(connection.Namespace)); err != nil {
		return nil, err
	}

	var names []string
	for _, corpus := range corpora.Items {
		if corpus.Spec.ConnectionRef == connection.Name {
			names = append(names, corpus.Name)
		}
	}
	slices.Sort(names)
	return names, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *ConnectionReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Connection{}).
		// Owns() is wrong here: a Corpus is not owned by its Connection (it
		// outlives one being replaced, and deleting the Connection must not
		// garbage-collect it). The count and the deletion block both change
		// when a Corpus appears or goes, so watch them plainly.
		Watches(&corev1alpha1.Corpus{}, handler.EnqueueRequestsFromMapFunc(connectionForCorpus)).
		Named("connection").
		Complete(r)
}

// connectionForCorpus maps a Corpus back to the Connection it draws from.
func connectionForCorpus(_ context.Context, obj client.Object) []reconcile.Request {
	corpus, ok := obj.(*corev1alpha1.Corpus)
	if !ok || corpus.Spec.ConnectionRef == "" {
		return nil
	}
	return []reconcile.Request{{
		NamespacedName: types.NamespacedName{Namespace: corpus.Namespace, Name: corpus.Spec.ConnectionRef},
	}}
}
