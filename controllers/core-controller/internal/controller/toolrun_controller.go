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

const (
	// defaultTimeoutSeconds is used when ToolRunSpec.TimeoutSeconds is unset.
	defaultTimeoutSeconds = int64(300)
	// defaultTTLSecondsAfterFinished mirrors the JS launcher's prior default
	// (job-launcher.ts LaunchOptions.ttlSecondsAfterFinished ?? 300).
	defaultTTLSecondsAfterFinished = int32(300)
	// jobRunAsUser/jobRunAsGroup mirror the Helm chart's pod securityContext
	// (uid/gid 10001), matching run.sh's hardened contract exactly.
	jobRunAsUser  = int64(10001)
	jobRunAsGroup = int64(10001)
)

// ToolRunReconciler reconciles a ToolRun object
type ToolRunReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=toolruns,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=toolruns/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=toolruns/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=tools,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=jobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=batch,resources=jobs/status,verbs=get

// Reconcile is the ONLY place in the system that creates a k8s Job (ADR 0010 —
// this replaces the JS orchestrator's K8sJobLauncher, which is left in place
// unwired). It resolves the referenced Tool, builds the same hardened
// container contract every tool/app in this repo uses (cap-drop ALL,
// read-only root fs, non-root, no privilege escalation, seccomp
// RuntimeDefault), creates the Job owned by the ToolRun, and mirrors the
// Job's status back onto ToolRun.status. Result/progress payloads still flow
// over the existing HMAC callback protocol (ADR 0006) unchanged — ToolRun
// status is only for lifecycle (Pending/Running/Succeeded/Failed), per the
// hybrid decision in ADR 0010.
func (r *ToolRunReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var run toolv1alpha1.ToolRun
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

func (r *ToolRunReconciler) createJob(ctx context.Context, run *toolv1alpha1.ToolRun) (ctrl.Result, error) {
	var tool toolv1alpha1.Tool
	toolKey := types.NamespacedName{Namespace: run.Namespace, Name: run.Spec.ToolRef}
	if err := r.Get(ctx, toolKey, &tool); err != nil {
		if apierrors.IsNotFound(err) {
			return r.markFailed(ctx, run, "ToolNotFound", fmt.Sprintf("referenced Tool %q not found", run.Spec.ToolRef))
		}
		return ctrl.Result{}, err
	}

	job, err := buildJob(run, &tool)
	if err != nil {
		return r.markFailed(ctx, run, "InvalidToolRun", err.Error())
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

func (r *ToolRunReconciler) syncJobStatus(ctx context.Context, run *toolv1alpha1.ToolRun, log logr.Logger) (ctrl.Result, error) {
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
	log.Info("toolrun status synced", "toolrun", run.Name, "phase", phase)
	return ctrl.Result{}, nil
}

func (r *ToolRunReconciler) markFailed(ctx context.Context, run *toolv1alpha1.ToolRun, reason, message string) (ctrl.Result, error) {
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

// buildJob mirrors job-launcher.ts's hardened contract, with two corrections
// found while porting: (1) tools actually read RECIPE_TRANSPORT /
// RECIPE_CALLBACK_URL / RECIPE_CALLBACK_SECRET (see tools/*/src/config.ts),
// not CALLBACK_URL/CALLBACK_SECRET as the JS launcher injected — using the
// correct names here; (2) adds runAsUser/runAsGroup 10001 + seccompProfile
// RuntimeDefault + an emptyDir /tmp mount, matching the Helm chart's pod
// securityContext (which the JS launcher never carried).
func buildJob(run *toolv1alpha1.ToolRun, tool *toolv1alpha1.Tool) (*batchv1.Job, error) {
	args := tool.Spec.Args
	if len(run.Spec.Args) > 0 {
		args = run.Spec.Args
	}

	// A per-invocation timeout on the ToolRun wins; otherwise fall back to the
	// Tool's own default (buildRunJob applies the global 300s default when both
	// are 0).
	timeoutSeconds := run.Spec.TimeoutSeconds
	if timeoutSeconds == 0 {
		timeoutSeconds = tool.Spec.TimeoutSeconds
	}

	return buildRunJob(runJobParams{
		jobName:     fmt.Sprintf("toolrun-%s", run.Name),
		namespace:   run.Namespace,
		annotations: sessionIDAnnotations(run.Annotations),
		labels: map[string]string{
			"core.controller-agent.dev/toolrun": run.Name,
			"core.controller-agent.dev/tool":    tool.Name,
		},
		image:              tool.Spec.Image,
		serviceAccountName: tool.Spec.ServiceAccountName,
		args:               args,
		staticEnv:          tool.Spec.Env,
		// mergeSecretEnv lets a caller inject a per-invocation credential
		// (e.g. a per-user GitHub identity-link token, ADR 0028) that
		// overrides or adds to the Tool's baked-in static secretEnv for this
		// one run only, without mutating the Tool CR -- same mechanism
		// AgentRunReconciler already uses for Agent/AgentRun.
		secretEnv:      mergeSecretEnv(tool.Spec.SecretEnv, run.Spec.SecretEnv),
		resources:      tool.Spec.Resources,
		callback:       run.Spec.Callback,
		timeoutSeconds: timeoutSeconds,
	})
}

// SetupWithManager sets up the controller with the Manager.
func (r *ToolRunReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.ToolRun{}).
		Owns(&batchv1.Job{}).
		Named("toolrun").
		Complete(r)
}
