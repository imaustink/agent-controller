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

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const integrationRouteConditionReady = "Ready"

// IntegrationRouteReconciler reconciles an IntegrationRoute object
type IntegrationRouteReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=integrationroutes,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=integrationroutes/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=integrationroutes/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=skills,verbs=get;list;watch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents,verbs=get;list;watch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools,verbs=get;list;watch

// Reconcile validates that an IntegrationRoute's single target ref
// (skillRef/agentRef/toolRef — the CRD's CEL rule guarantees exactly one is
// set) corresponds to an existing resource in the same namespace, and sets a
// Ready condition accordingly. Like SkillReconciler, this is a static-config
// sanity check, not an authorization boundary — the JS orchestrator
// re-validates the caller's roles against the resolved target at call time.
func (r *IntegrationRouteReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var route toolv1alpha1.IntegrationRoute
	if err := r.Get(ctx, req.NamespacedName, &route); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	resolved, err := r.targetResolved(ctx, route)
	if err != nil {
		return ctrl.Result{}, err
	}

	condition := metav1.Condition{
		Type:               integrationRouteConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "RefResolved",
		Message:            "route target resolved to an existing resource",
		ObservedGeneration: route.Generation,
	}
	if !resolved {
		condition.Status = metav1.ConditionFalse
		condition.Reason = "RefMissing"
		condition.Message = "route target does not correspond to an existing Skill/Agent/Tool resource"
		log.Info("integration route target missing", "route", route.Name)
	}

	meta.SetStatusCondition(&route.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &route); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

// targetResolved checks whether the route's single target ref names an
// existing resource. Returns false (not an error) when the referenced
// resource simply doesn't exist yet.
func (r *IntegrationRouteReconciler) targetResolved(ctx context.Context, route toolv1alpha1.IntegrationRoute) (bool, error) {
	get := func(obj client.Object, name string) (bool, error) {
		key := types.NamespacedName{Namespace: route.Namespace, Name: name}
		if err := r.Get(ctx, key, obj); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}

	switch {
	case route.Spec.SkillRef != "":
		return get(&toolv1alpha1.Skill{}, route.Spec.SkillRef)
	case route.Spec.AgentRef != "":
		return get(&toolv1alpha1.Agent{}, route.Spec.AgentRef)
	case route.Spec.ToolRef != "":
		return get(&toolv1alpha1.Tool{}, route.Spec.ToolRef)
	default:
		// CEL admission rule guarantees one of the above is set; nothing to
		// resolve here should be unreachable in practice.
		return false, nil
	}
}

// SetupWithManager sets up the controller with the Manager.
func (r *IntegrationRouteReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.IntegrationRoute{}).
		Named("integrationroute").
		Complete(r)
}
