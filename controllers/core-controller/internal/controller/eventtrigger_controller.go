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

	"github.com/google/cel-go/cel"
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
	"github.com/controller-agent/core-controller/internal/eventcel"
)

const eventTriggerConditionReady = "Ready"

// EventTriggerReconciler reconciles a EventTrigger object
type EventTriggerReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventtriggers,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventtriggers/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventtriggers/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventsources,verbs=get;list;watch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=skills,verbs=get;list;watch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents,verbs=get;list;watch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools,verbs=get;list;watch

// Reconcile sets an EventTrigger's Ready condition: its CEL compiles, its
// sourceRef (if any) names an existing EventSource, and its single target ref
// names an existing Skill/Agent/Tool in the same namespace.
//
// Ready is what the engines match on (docs/event-triggers.md §4), so a trigger
// that would fail at dispatch never matches: a CEL error is fail-closed here
// rather than a per-event evaluation error. Like SkillReconciler, ref
// resolution is a static-config check, not an authorization boundary — the
// orchestrator re-resolves the target under the caller's roles at call time.
func (r *EventTriggerReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var trigger corev1alpha1.EventTrigger
	if err := r.Get(ctx, req.NamespacedName, &trigger); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	condition := metav1.Condition{
		Type:               eventTriggerConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "Resolved",
		Message:            "CEL compiles and every ref resolves",
		ObservedGeneration: trigger.Generation,
	}

	reason, message, err := r.check(ctx, &trigger)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		condition.Status = metav1.ConditionFalse
		condition.Reason = reason
		condition.Message = message
		log.Info("EventTrigger not ready", "eventtrigger", trigger.Name, "reason", reason)
	}

	meta.SetStatusCondition(&trigger.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &trigger); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// check returns the reason and message the trigger is not Ready, or "" when
// it is. CEL is checked first: it is the trigger's own fault and no amount of
// waiting for another resource fixes it.
func (r *EventTriggerReconciler) check(ctx context.Context, trigger *corev1alpha1.EventTrigger) (reason, message string, err error) {
	if expr := trigger.Spec.Match.CEL; expr != "" {
		if err := eventcel.Compile(expr, cel.BoolType); err != nil {
			return "InvalidCEL", fmt.Sprintf("match.cel: %v", err), nil
		}
	}
	// Sorted so the reported param is stable across reconciles.
	names := make([]string, 0, len(trigger.Spec.Params))
	for name := range trigger.Spec.Params {
		names = append(names, name)
	}
	slices.Sort(names)
	for _, name := range names {
		if err := eventcel.Compile(trigger.Spec.Params[name], nil); err != nil {
			return "InvalidCEL", fmt.Sprintf("params.%s: %v", name, err), nil
		}
	}

	exists := func(obj client.Object, name string) (bool, error) {
		key := types.NamespacedName{Namespace: trigger.Namespace, Name: name}
		if err := r.Get(ctx, key, obj); err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}

	if ref := trigger.Spec.SourceRef; ref != "" {
		ok, err := exists(&corev1alpha1.EventSource{}, ref)
		if err != nil {
			return "", "", err
		}
		if !ok {
			return "SourceNotFound", fmt.Sprintf("sourceRef EventSource %q does not exist", ref), nil
		}
	}

	target := trigger.Spec.Target
	var (
		obj  client.Object
		kind string
		name string
	)
	switch {
	case target.Orchestrator != nil:
		return "", "", nil
	case target.SkillRef != "":
		obj, kind, name = &corev1alpha1.Skill{}, "Skill", target.SkillRef
	case target.AgentRef != "":
		obj, kind, name = &corev1alpha1.Agent{}, "Agent", target.AgentRef
	case target.ToolRef != "":
		obj, kind, name = &corev1alpha1.Tool{}, "Tool", target.ToolRef
	default:
		// Admission's oneOf rule makes this unreachable.
		return "TargetNotFound", "target sets none of orchestrator, skillRef, agentRef or toolRef", nil
	}
	ok, err := exists(obj, name)
	if err != nil {
		return "", "", err
	}
	if !ok {
		return "TargetNotFound", fmt.Sprintf("target %s %q does not exist", kind, name), nil
	}
	return "", "", nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *EventTriggerReconciler) SetupWithManager(mgr ctrl.Manager) error {
	// A trigger's readiness depends on resources it names, so their
	// appearance or deletion re-checks every trigger naming them — otherwise a
	// trigger applied before its target would stay NotReady (and unmatched)
	// until something else touched it.
	byRef := func(refOf func(*corev1alpha1.EventTrigger) string) handler.EventHandler {
		return handler.EnqueueRequestsFromMapFunc(func(ctx context.Context, obj client.Object) []reconcile.Request {
			return r.triggersReferencing(ctx, obj, refOf)
		})
	}
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.EventTrigger{}).
		Watches(&corev1alpha1.EventSource{}, byRef(func(t *corev1alpha1.EventTrigger) string { return t.Spec.SourceRef })).
		Watches(&corev1alpha1.Skill{}, byRef(func(t *corev1alpha1.EventTrigger) string { return t.Spec.Target.SkillRef })).
		Watches(&corev1alpha1.Agent{}, byRef(func(t *corev1alpha1.EventTrigger) string { return t.Spec.Target.AgentRef })).
		Watches(&corev1alpha1.Tool{}, byRef(func(t *corev1alpha1.EventTrigger) string { return t.Spec.Target.ToolRef })).
		Named("eventtrigger").
		Complete(r)
}

func (r *EventTriggerReconciler) triggersReferencing(
	ctx context.Context,
	obj client.Object,
	refOf func(*corev1alpha1.EventTrigger) string,
) []reconcile.Request {
	var triggers corev1alpha1.EventTriggerList
	if err := r.List(ctx, &triggers, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}
	var requests []reconcile.Request
	for i := range triggers.Items {
		t := &triggers.Items[i]
		if refOf(t) != obj.GetName() {
			continue
		}
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{Namespace: t.Namespace, Name: t.Name},
		})
	}
	return requests
}
