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
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const identityProviderConditionReady = "Ready"

// IdentityProviderReconciler reconciles an IdentityProvider object. There is
// nothing to launch or reclaim here -- an IdentityProvider is pure catalog
// data, read by agent-orchestrator the same way it reads Tool/Agent/Skill
// (see identityprovider_types.go). This reconciler's only job is the cross-CR
// check the CRD's OpenAPI schema can't express on its own: envVar and label
// must each be unique across the namespace, since a collision on either would
// silently misroute a credential (envVar) or make two providers' link
// prompts indistinguishable to the person completing them (label --
// docs/adr/0027's "please link your Claude account" collision that this CRD
// exists to keep from happening again).
type IdentityProviderReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=identityproviders,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=identityproviders/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=identityproviders/finalizers,verbs=update

// Reconcile validates that no other IdentityProvider in the same namespace
// shares this one's envVar or label, and sets a Ready condition accordingly.
func (r *IdentityProviderReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var provider toolv1alpha1.IdentityProvider
	if err := r.Get(ctx, req.NamespacedName, &provider); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	var siblings toolv1alpha1.IdentityProviderList
	if err := r.List(ctx, &siblings, client.InNamespace(provider.Namespace)); err != nil {
		return ctrl.Result{}, err
	}

	var problems []string
	for _, other := range siblings.Items {
		if other.Name == provider.Name {
			continue
		}
		if other.Spec.EnvVar == provider.Spec.EnvVar {
			problems = append(problems, fmt.Sprintf("envVar %q is also used by IdentityProvider %q", provider.Spec.EnvVar, other.Name))
		}
		if other.Spec.Label == provider.Spec.Label {
			problems = append(problems, fmt.Sprintf("label %q is also used by IdentityProvider %q", provider.Spec.Label, other.Name))
		}
	}

	condition := metav1.Condition{
		Type:               identityProviderConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "Unique",
		Message:            "envVar and label are unique across this namespace's IdentityProviders",
		ObservedGeneration: provider.Generation,
	}
	if len(problems) > 0 {
		condition.Status = metav1.ConditionFalse
		condition.Reason = "Collision"
		condition.Message = strings.Join(problems, "; ")
		log.Info("identityprovider collides with a sibling", "identityprovider", provider.Name, "problems", problems)
	}

	meta.SetStatusCondition(&provider.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &provider); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *IdentityProviderReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.IdentityProvider{}).
		Named("identityprovider").
		Complete(r)
}
