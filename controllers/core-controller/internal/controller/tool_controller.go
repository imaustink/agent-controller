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

	"github.com/go-logr/logr"
	corev1 "k8s.io/api/core/v1"
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

const (
	toolConditionReady  = "Ready"
	toolRecheckInterval = 30 * time.Second
)

// ToolReconciler reconciles a Tool object
type ToolReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch

// Reconcile validates a Tool's launch target exists and sets a Ready
// condition accordingly. A container Tool (image + serviceAccountName)
// validates its ServiceAccount exists in the same namespace; an agent-backed
// Tool (agentRef) validates the referenced Agent CR exists instead. Tool is
// otherwise pure catalog metadata consumed by the JS orchestrator's own
// informer/embedder \u2014 this controller does not create tool ServiceAccounts
// or Agents, only reports whether the referenced one is missing.
func (r *ToolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var tool toolv1alpha1.Tool
	if err := r.Get(ctx, req.NamespacedName, &tool); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	var condition metav1.Condition
	if tool.Spec.AgentRef != "" {
		condition = r.checkAgentRef(ctx, log, &tool)
	} else {
		condition = r.checkServiceAccount(ctx, log, &tool)
	}
	condition.ObservedGeneration = tool.Generation

	meta.SetStatusCondition(&tool.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &tool); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

func (r *ToolReconciler) checkServiceAccount(ctx context.Context, log logr.Logger, tool *toolv1alpha1.Tool) metav1.Condition {
	condition := metav1.Condition{
		Type:    toolConditionReady,
		Status:  metav1.ConditionTrue,
		Reason:  "ServiceAccountFound",
		Message: fmt.Sprintf("serviceAccount %q found", tool.Spec.ServiceAccountName),
	}

	var sa corev1.ServiceAccount
	saKey := types.NamespacedName{Namespace: tool.Namespace, Name: tool.Spec.ServiceAccountName}
	if err := r.Get(ctx, saKey, &sa); err != nil {
		if !apierrors.IsNotFound(err) {
			condition.Status = metav1.ConditionUnknown
			condition.Reason = "ServiceAccountLookupFailed"
			condition.Message = err.Error()
			return condition
		}
		condition.Status = metav1.ConditionFalse
		condition.Reason = "ServiceAccountMissing"
		condition.Message = fmt.Sprintf("serviceAccount %q not found in namespace %q \u2014 ToolRuns for this Tool will fail to launch", tool.Spec.ServiceAccountName, tool.Namespace)
		log.Info("tool references missing service account", "tool", tool.Name, "serviceAccount", tool.Spec.ServiceAccountName)
	}
	return condition
}

func (r *ToolReconciler) checkAgentRef(ctx context.Context, log logr.Logger, tool *toolv1alpha1.Tool) metav1.Condition {
	condition := metav1.Condition{
		Type:    toolConditionReady,
		Status:  metav1.ConditionTrue,
		Reason:  "AgentRefFound",
		Message: fmt.Sprintf("agent %q found", tool.Spec.AgentRef),
	}

	var agent toolv1alpha1.Agent
	agentKey := types.NamespacedName{Namespace: tool.Namespace, Name: tool.Spec.AgentRef}
	if err := r.Get(ctx, agentKey, &agent); err != nil {
		if !apierrors.IsNotFound(err) {
			condition.Status = metav1.ConditionUnknown
			condition.Reason = "AgentRefLookupFailed"
			condition.Message = err.Error()
			return condition
		}
		condition.Status = metav1.ConditionFalse
		condition.Reason = "AgentRefMissing"
		condition.Message = fmt.Sprintf("agent %q not found in namespace %q \u2014 this Tool will fail to dispatch", tool.Spec.AgentRef, tool.Namespace)
		log.Info("tool references missing agent", "tool", tool.Name, "agentRef", tool.Spec.AgentRef)
	}
	return condition
}

// SetupWithManager sets up the controller with the Manager.
func (r *ToolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.Tool{}).
		Named("tool").
		Complete(r)
}
