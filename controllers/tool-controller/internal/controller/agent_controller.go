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

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/tool-controller/api/v1alpha1"
)

const agentConditionReady = "Ready"

// AgentReconciler reconciles a Agent object
type AgentReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=skills,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch

// Reconcile validates an Agent's launch prerequisites and sets a Ready
// condition: the referenced ServiceAccount must exist in the same namespace
// (mirrors ToolReconciler) and every spec.skillRefs entry must resolve to an
// existing Skill CR (mirrors SkillReconciler's toolRefs check). Like both,
// this is a static-config sanity check — the agent loop itself re-validates
// what it may call at run time.
func (r *AgentReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var agent toolv1alpha1.Agent
	if err := r.Get(ctx, req.NamespacedName, &agent); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	condition := metav1.Condition{
		Type:               agentConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "Ready",
		Message:            "serviceAccount found and all skillRefs resolved",
		ObservedGeneration: agent.Generation,
	}

	var sa corev1.ServiceAccount
	saKey := types.NamespacedName{Namespace: agent.Namespace, Name: agent.Spec.ServiceAccountName}
	if err := r.Get(ctx, saKey, &sa); err != nil {
		if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		condition.Status = metav1.ConditionFalse
		condition.Reason = "ServiceAccountMissing"
		condition.Message = fmt.Sprintf("serviceAccount %q not found in namespace %q — AgentRuns for this Agent will fail to launch", agent.Spec.ServiceAccountName, agent.Namespace)
		log.Info("agent references missing service account", "agent", agent.Name, "serviceAccount", agent.Spec.ServiceAccountName)
	}

	if condition.Status == metav1.ConditionTrue {
		var missing []string
		for _, ref := range agent.Spec.SkillRefs {
			var s toolv1alpha1.Skill
			key := types.NamespacedName{Namespace: agent.Namespace, Name: ref}
			if err := r.Get(ctx, key, &s); err != nil {
				if !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
				missing = append(missing, ref)
			}
		}
		if len(missing) > 0 {
			condition.Status = metav1.ConditionFalse
			condition.Reason = "SkillRefsMissing"
			condition.Message = fmt.Sprintf("skillRefs not found: %v", missing)
			log.Info("agent references missing skills", "agent", agent.Name, "missing", missing)
		}
	}

	meta.SetStatusCondition(&agent.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &agent); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *AgentReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.Agent{}).
		Named("agent").
		Complete(r)
}
