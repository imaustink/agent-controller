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

	batchv1 "k8s.io/api/batch/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

// AgentRunReconciler reconciles a AgentRun object
type AgentRunReconciler struct {
	client.Client
	Scheme *runtime.Scheme
	// NatsConfig holds the NATS connection settings injected into every agent
	// Job so the @controller-agent/agent-runtime SDK can connect on startup.
	// Set from the controller manager's own env at startup (cmd/main.go).
	NatsConfig AgentNatsConfig
	// Retention is how long a terminal AgentRun (and the Secret it owns) is
	// kept before reclamation. Zero means DefaultAgentRunRetention -- there is
	// deliberately no "keep forever" setting, since that is the behaviour that
	// let credential-bearing Secrets accumulate indefinitely.
	Retention time.Duration
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

	// Already terminal — reclaim it once its retention window has elapsed.
	//
	// Nothing else ever deleted an AgentRun. The Job it creates carries a TTL
	// and disappears, but the CR and the per-run `<name>-identity` Secret it
	// owns persisted forever: a live cluster was found holding runs 8 days old,
	// each still carrying encrypted credential material in etcd long after the
	// run that needed it had finished. That is both unbounded object growth and
	// a credential-lifetime problem, so retention is bounded here rather than
	// left to an operator remembering to prune.
	//
	// Deleting the CR cascades to the Secret through its ownerReference, so
	// this single delete reclaims both.
	if run.Status.Phase == toolv1alpha1.ToolRunPhaseSucceeded || run.Status.Phase == toolv1alpha1.ToolRunPhaseFailed {
		retention := r.retention()
		// A run whose completion time was never recorded (older CRs predate the
		// field) falls back to its creation time -- reclaiming late is fine,
		// never reclaiming is not.
		finishedAt := run.Status.CompletionTime
		if finishedAt == nil {
			finishedAt = &run.CreationTimestamp
		}
		age := time.Since(finishedAt.Time)
		if age >= retention {
			log.Info("reclaiming terminal AgentRun", "name", run.Name, "phase", run.Status.Phase, "age", age.String())
			if err := r.Delete(ctx, &run); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			return ctrl.Result{}, nil
		}
		// Come back exactly when it becomes eligible rather than polling.
		return ctrl.Result{RequeueAfter: retention - age}, nil
	}

	if run.Status.JobName == "" {
		return r.createJob(ctx, &run)
	}

	return r.syncJobStatus(ctx, &run)
}

// DefaultAgentRunRetention is how long a terminal AgentRun (and the Secret it
// owns) is kept before being reclaimed. Long enough to inspect a failure by
// hand, short enough that credential material does not linger.
const DefaultAgentRunRetention = 1 * time.Hour

// retention returns the configured retention window, falling back to
// DefaultAgentRunRetention when unset so an operator who never configures it
// still gets bounded growth.
func (r *AgentRunReconciler) retention() time.Duration {
	if r.Retention > 0 {
		return r.Retention
	}
	return DefaultAgentRunRetention
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
		// run.Name IS the Job name directly, not "agentrun-"+run.Name: the
		// Temporal engine (engines/temporal's BridgedAgentWorkflow) names
		// AgentRun CRs "agentrun-<agentId>-<uuid>" itself, so prepending this
		// prefix again produced a Job name (and therefore the API server's
		// auto-added spec.template.labels["job-name"], which reuses the Job's
		// own name verbatim with no truncation) exceeding the 63-byte label
		// limit -- the exact failure mode this fixes. Job lookup is by owner
		// reference (`.Owns(&batchv1.Job{})` below), never by reconstructing
		// this name, so dropping the prefix changes nothing else.
		jobName:     run.Name,
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

func (r *AgentRunReconciler) syncJobStatus(ctx context.Context, run *toolv1alpha1.AgentRun) (ctrl.Result, error) {
	log := logf.FromContext(ctx)
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
	// meta.SetStatusCondition, not append: it stamps LastTransitionTime (which
	// the CRD schema REQUIRES, so a hand-built condition without it is rejected
	// outright -- "status.conditions[0].lastTransitionTime: Required value") and
	// replaces any existing condition of the same type instead of adding a
	// duplicate, which the schema also rejects since conditions is a map-list
	// keyed by type.
	//
	// Appending raw wedged runs permanently. This function is the ONLY thing that
	// moves a run whose Job has vanished to a terminal phase, so a rejected
	// update meant the run stayed Running forever, was re-reconciled every few
	// minutes, failed the same way, and was never eligible for the retention
	// sweep below -- which only reclaims TERMINAL runs. Observed in production:
	// three AgentRuns and a ToolRun stuck Running for two days, each logging this
	// error on every reconcile. Every other controller here already used this
	// helper; these two were the outliers.
	meta.SetStatusCondition(&run.Status.Conditions, metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: run.Generation,
	})
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
