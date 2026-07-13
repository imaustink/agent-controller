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
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/tool-controller/api/v1alpha1"
)

const skillConditionReady = "Ready"

// SkillReconciler reconciles a Skill object
type SkillReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=skills,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=skills/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=skills/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools,verbs=get;list;watch

// Reconcile validates that every name in a Skill's toolRefs corresponds to an
// existing Tool CR in the same namespace, and sets a Ready condition
// accordingly. The action planner (JS orchestrator) still re-validates a
// chosen toolId against this list at call time — this is a static-config
// sanity check, not an authorization boundary.
func (r *SkillReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var skill toolv1alpha1.Skill
	if err := r.Get(ctx, req.NamespacedName, &skill); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	var missing []string
	for _, ref := range skill.Spec.ToolRefs {
		var t toolv1alpha1.Tool
		key := types.NamespacedName{Namespace: skill.Namespace, Name: ref}
		if err := r.Get(ctx, key, &t); err != nil {
			if !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			missing = append(missing, ref)
		}
	}

	condition := metav1.Condition{
		Type:               skillConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "ToolRefsResolved",
		Message:            "all toolRefs resolved to existing Tool resources",
		ObservedGeneration: skill.Generation,
	}
	if len(missing) > 0 {
		condition.Status = metav1.ConditionFalse
		condition.Reason = "ToolRefsMissing"
		condition.Message = fmt.Sprintf("toolRefs not found: %v", missing)
		log.Info("skill references missing tools", "skill", skill.Name, "missing", missing)
	}

	meta.SetStatusCondition(&skill.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &skill); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *SkillReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.Skill{}).
		Named("skill").
		Complete(r)
}
