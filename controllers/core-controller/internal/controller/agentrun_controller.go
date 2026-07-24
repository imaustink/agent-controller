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

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
	"github.com/go-logr/logr"
)

// AgentRunReconciler reconciles a AgentRun object
type AgentRunReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// NatsConfig holds the NATS connection settings injected into every agent
	// Job so the @controller-agent/agent-runtime SDK can connect on startup.
	// Set from the controller manager's own env at startup (cmd/main.go).
	NatsConfig AgentNatsConfig
}

// AgentNatsConfig is the NATS connection config injected into every agent Job.
// Values come from the controller's OWN environment, not from the AgentRun CR.
type AgentNatsConfig struct {
	// NatsURL is the NATS server URL (AGENT_NATS_URL env on the controller pod).
	NatsURL string
	// SubjectPrefix is the NATS subject prefix (AGENT_NATS_SUBJECT_PREFIX env,
	// default "agent").
	SubjectPrefix string
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agentruns,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agentruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agentruns/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=agents,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=batch,resources=jobs/status,verbs=get

// Reconcile mirrors ToolRunReconciler exactly, but for Agent invocations:
// resolves the referenced Agent, launches the same hardened one-shot Job
// (shared buildRunJob), with the run's natural-language `goal` as the
// container argument instead of tool args, and mirrors the Job's status
// onto AgentRun.status. Result payloads flow over the same callback
// protocol (ADR 0006/0010).
func (r *AgentRunReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var run toolv1alpha1.AgentRun
	if err := r.Get(ctx, req.NamespacedName, &run); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Already terminal — nothing left to reconcile for lifecycle purposes.
	if run.Status.Phase == toolv1alpha1.ToolRunPhaseSucceeded || run.Status.Phase == toolv1alpha1.ToolRunPhaseFailed {
		return ctrl.Result{}, nil
	}

	if run.Status.JobName == "" {
		return r.createJob(ctx, &run)
	}

	return r.syncJobStatus(ctx, &run, log)
}

func (r *AgentRunReconciler) createJob(ctx context.Context, run *toolv1alpha1.AgentRun) (ctrl.Result, error) {
	var agent toolv1alpha1.Agent
	agentKey := types.NamespacedName{Namespace: run.Namespace, Name: run.Spec.AgentRef}
	if err := r.Get(ctx, agentKey, &agent); err != nil {
		if apierrors.IsNotFound(err) {
			return r.markFailed(ctx, run, "AgentNotFound", fmt.Sprintf("referenced Agent %q not found", run.Spec.AgentRef))
		}
		return ctrl.Result{}, err
	}

	job, err := buildRunJob(runJobParams{
		jobName:     fmt.Sprintf("agentrun-%s", run.Name),
		namespace:   run.Namespace,
		annotations: sessionIDAnnotations(run.Annotations),
		labels: map[string]string{
			"core.controller-agent.dev/agentrun": run.Name,
			"core.controller-agent.dev/agent":    agent.Name,
		},
		image:              agent.Spec.Image,
		serviceAccountName: agent.Spec.ServiceAccountName,
		// The agent-runtime SDK reads the goal from AGENT_GOAL env (not argv),
		// to avoid shell escaping issues with arbitrary natural-language goals.
		args:           nil,
		staticEnv:      append(agent.Spec.Env, r.agentRuntimeEnv(run.Name, run.Spec.Goal)...),
		secretEnv:      mergeSecretEnv(agent.Spec.SecretEnv, run.Spec.SecretEnv),
		resources:      agent.Spec.Resources,
		initContainers: agent.Spec.InitContainers,
		callback:       run.Spec.Callback,
		timeoutSeconds: run.Spec.TimeoutSeconds,
	})
	if err != nil {
		return r.markFailed(ctx, run, "InvalidAgentRun", err.Error())
	}

	if err := controllerutil.SetControllerReference(run, job, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}

	if err := r.Create(ctx, job); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
	}

	run.Status.Phase = toolv1alpha1.ToolRunPhasePending
	run.Status.JobName = job.Name
	if err := r.Status().Update(ctx, run); err != nil {
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

func (r *AgentRunReconciler) syncJobStatus(ctx context.Context, run *toolv1alpha1.AgentRun, log logr.Logger) (ctrl.Result, error) {
	var job batchv1.Job
	jobKey := types.NamespacedName{Namespace: run.Namespace, Name: run.Status.JobName}
	if err := r.Get(ctx, jobKey, &job); err != nil {
		if apierrors.IsNotFound(err) {
			// Job vanished (e.g. TTL cleanup) before we recorded a terminal
			// phase — treat as failed rather than silently going stale.
			return r.markFailed(ctx, run, "JobMissing", fmt.Sprintf("owned Job %q no longer exists", run.Status.JobName))
		}
		return ctrl.Result{}, err
	}

	phase, message := jobPhase(&job, run.Status.Message)

	if phase == run.Status.Phase && job.Status.StartTime == nil {
		return ctrl.Result{}, nil
	}

	run.Status.Phase = phase
	run.Status.Message = message
	if job.Status.StartTime != nil {
		run.Status.StartTime = job.Status.StartTime
	}
	if job.Status.CompletionTime != nil {
		run.Status.CompletionTime = job.Status.CompletionTime
	}

	if err := r.Status().Update(ctx, run); err != nil {
		return ctrl.Result{}, err
	}
	log.Info("agentrun status synced", "agentrun", run.Name, "phase", phase)
	return ctrl.Result{}, nil
}

func (r *AgentRunReconciler) markFailed(ctx context.Context, run *toolv1alpha1.AgentRun, reason, message string) (ctrl.Result, error) {
	run.Status.Phase = toolv1alpha1.ToolRunPhaseFailed
	run.Status.Message = message
	cond := metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: run.Generation,
	}
	run.Status.Conditions = append(run.Status.Conditions, cond)
	if err := r.Status().Update(ctx, run); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *AgentRunReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.AgentRun{}).
		Owns(&batchv1.Job{}).
		Named("agentrun").
		Complete(r)
}

// agentRuntimeEnv returns the env vars the @controller-agent/agent-runtime SDK
// needs to boot: the run's own identity (AGENT_RUN_ID, AGENT_GOAL) and the
// NATS connection details (AGENT_NATS_URL, AGENT_NATS_SUBJECT_PREFIX).
func (r *AgentRunReconciler) agentRuntimeEnv(runName, goal string) []toolv1alpha1.EnvVar {
	prefix := r.NatsConfig.SubjectPrefix
	if prefix == "" {
		prefix = "agent"
	}
	natsURL := r.NatsConfig.NatsURL
	if natsURL == "" {
		natsURL = "nats://nats:4222"
	}
	return []toolv1alpha1.EnvVar{
		{Name: "AGENT_RUN_ID", Value: runName},
		{Name: "AGENT_GOAL", Value: goal},
		{Name: "AGENT_NATS_URL", Value: natsURL},
		{Name: "AGENT_NATS_SUBJECT_PREFIX", Value: prefix},
	}
}
