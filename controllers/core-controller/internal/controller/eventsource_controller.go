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
	"time"

	"github.com/google/cel-go/cel"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/equality"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/utils/ptr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
	"github.com/controller-agent/core-controller/internal/eventcel"
)

const (
	eventSourceConditionReady = "Ready"

	// eventSourceSecretRecheckInterval is how often a Ready webhook source
	// re-confirms its Secret. Secrets are not watched (see SecretReader), so
	// this bounds how long a deleted Secret goes unreported.
	eventSourceSecretRecheckInterval = 5 * time.Minute

	// maxCronJobNameLength is the API server's limit: a CronJob's Jobs get an
	// 11-character suffix and must stay within 63.
	maxCronJobNameLength = 52

	// TickTokenAudience is the audience of a tick's projected ServiceAccount
	// token; integration-gateway reviews tokens for exactly this audience
	// (apps/integration-gateway/src/tick-auth.ts).
	TickTokenAudience = "integration-gateway.events"

	// tickTokenExpirySeconds is the projected token's lifetime: the API
	// server's minimum, far longer than a tick (curl --max-time 30).
	tickTokenExpirySeconds = 600

	tickTokenDir  = "/var/run/secrets/eventsource"
	tickTokenFile = "token"
)

// EventSourceReconciler reconciles a EventSource object
type EventSourceReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	// SecretReader reads a webhook source's verification Secret. It should be
	// uncached (mgr.GetAPIReader()): reading Secrets through the manager's
	// cache would start a cluster-wide Secret informer — and need list/watch
	// over every Secret — to confirm one key exists. Nil falls back to Client.
	SecretReader client.Reader

	// TickImage runs a cron source's CronJob (needs only a shell and curl).
	TickImage string
	// TickURL is integration-gateway's base URL; empty disables cron sources.
	TickURL string
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventsources,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventsources/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=eventsources/finalizers,verbs=update
// +kubebuilder:rbac:groups=batch,resources=cronjobs,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=secrets,verbs=get

// Reconcile reports whether an EventSource can deliver events, and for a cron
// source materializes the CronJob that ticks it (docs/event-triggers.md §8).
//
// A webhook source is only Ready when the gateway could actually verify a
// delivery with it: the Secret and key it names exist, and every sender CEL
// expression compiles. Anything less would be a source that 401s every
// delivery, or one the gateway refuses at load, while kubectl says Ready.
func (r *EventSourceReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	var source corev1alpha1.EventSource
	if err := r.Get(ctx, req.NamespacedName, &source); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// Status is written once, here, and only when it changed: every path
	// below mutates source.Status in place (setReady) rather than writing it,
	// so the comparison sees CronJobName as well as the Ready condition.
	before := source.Status.DeepCopy()
	result, err := r.reconcile(ctx, &source)
	if err != nil || equality.Semantic.DeepEqual(before, &source.Status) {
		return result, err
	}
	if err := r.Status().Update(ctx, &source); err != nil {
		return ctrl.Result{}, err
	}
	return result, nil
}

// reconcile does Reconcile's work, leaving the status write to it.
func (r *EventSourceReconciler) reconcile(ctx context.Context, source *corev1alpha1.EventSource) (ctrl.Result, error) {
	if source.Spec.Cron != nil {
		return r.reconcileCron(ctx, source)
	}

	// Not (or no longer) a cron source: a CronJob left from a previous spec
	// would go on ticking a source the gateway now serves as a webhook.
	if err := r.deleteTickResources(ctx, source); err != nil {
		return ctrl.Result{}, err
	}
	source.Status.CronJobName = ""

	if source.Spec.Webhook == nil {
		// Admission's oneOf rule makes this unreachable; report it rather than
		// guess.
		return r.setReady(ctx, source, metav1.ConditionFalse, "InvalidSpec",
			"exactly one of webhook or cron must be set", 0)
	}

	if msg := checkSenderCEL(source.Spec.Sender); msg != "" {
		return r.setReady(ctx, source, metav1.ConditionFalse, "InvalidCEL", msg, 0)
	}

	ref := source.Spec.Webhook.Verify.SecretRef
	var secret corev1.Secret
	err := r.secretReader().Get(ctx, types.NamespacedName{Namespace: source.Namespace, Name: ref.Name}, &secret)
	if apierrors.IsNotFound(err) {
		return r.setReady(ctx, source, metav1.ConditionFalse, "SecretNotFound",
			fmt.Sprintf("verify.secretRef Secret %q does not exist", ref.Name), toolRecheckInterval)
	}
	if err != nil {
		return ctrl.Result{}, err
	}
	if _, ok := secret.Data[ref.Key]; !ok {
		return r.setReady(ctx, source, metav1.ConditionFalse, "SecretKeyMissing",
			fmt.Sprintf("Secret %q has no key %q", ref.Name, ref.Key), toolRecheckInterval)
	}

	return r.setReady(ctx, source, metav1.ConditionTrue, "Verifiable",
		fmt.Sprintf("served at /webhooks/%s, verified by %s", source.Name, source.Spec.Webhook.Verify.Scheme),
		eventSourceSecretRecheckInterval)
}

// reconcileCron materializes a cron source as an owned CronJob.
//
// The schedule lives in the API server rather than in integration-gateway:
// the gateway runs several replicas, so an in-process timer would fire once
// per replica, and would die with the pod (ADR 0048 §3).
func (r *EventSourceReconciler) reconcileCron(ctx context.Context, source *corev1alpha1.EventSource) (ctrl.Result, error) {
	if r.TickURL == "" {
		// A CronJob with nowhere to POST would fail every tick; better none and
		// a condition that says why.
		if err := r.deleteTickResources(ctx, source); err != nil {
			return ctrl.Result{}, err
		}
		source.Status.CronJobName = ""
		return r.setReady(ctx, source, metav1.ConditionFalse, "TickNotConfigured",
			"core-controller has no EVENT_TICK_URL; cron sources cannot tick", 0)
	}

	name := TickCronJobName(source.Name)
	if len(name) > maxCronJobNameLength {
		source.Status.CronJobName = ""
		return r.setReady(ctx, source, metav1.ConditionFalse, "NameTooLong",
			fmt.Sprintf("CronJob name %q exceeds %d characters; shorten the EventSource name", name, maxCronJobNameLength), 0)
	}

	if err := r.applyTickServiceAccount(ctx, source, name); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.applyTickCronJob(ctx, source, name); err != nil {
		// An unparseable schedule or zone is the operator's to fix, not a
		// transient error to retry into.
		if apierrors.IsInvalid(err) {
			source.Status.CronJobName = ""
			return r.setReady(ctx, source, metav1.ConditionFalse, "InvalidSchedule", err.Error(), 0)
		}
		return ctrl.Result{}, err
	}

	source.Status.CronJobName = name
	return r.setReady(ctx, source, metav1.ConditionTrue, "Scheduled",
		fmt.Sprintf("CronJob %s ticks on %q", name, source.Spec.Cron.Schedule), 0)
}

// TickCronJobName is the CronJob a cron EventSource owns. Its ServiceAccount
// shares the name: the gateway accepts a tick for source X only from
// system:serviceaccount:<ns>:eventsource-X.
func TickCronJobName(source string) string { return "eventsource-" + source }

// applyTickServiceAccount creates the source's own ServiceAccount: the tick's
// identity. It is bound to no Role -- the gateway only asks the API server
// who the token belongs to -- so it grants nothing beyond "I am this
// source's tick".
func (r *EventSourceReconciler) applyTickServiceAccount(ctx context.Context, source *corev1alpha1.EventSource, name string) error {
	desired := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: source.Namespace,
			Labels: map[string]string{
				"core.controller-agent.dev/eventsource": source.Name,
			},
		},
		// Only the projected, audience-bound token is ever mounted.
		AutomountServiceAccountToken: ptr.To(false),
	}
	if err := controllerutil.SetControllerReference(source, desired, r.Scheme); err != nil {
		return err
	}

	var existing corev1.ServiceAccount
	err := r.Get(ctx, types.NamespacedName{Namespace: source.Namespace, Name: name}, &existing)
	if apierrors.IsNotFound(err) {
		logf.FromContext(ctx).Info("Creating tick ServiceAccount", "eventsource", source.Name)
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}
	if !metav1.IsControlledBy(&existing, source) {
		// Someone else's ServiceAccount with our name would let THEIR pods
		// tick this source. Refuse rather than adopt it.
		return fmt.Errorf("ServiceAccount %s/%s exists and is not owned by EventSource %s", source.Namespace, name, source.Name)
	}
	existing.Labels = desired.Labels
	existing.AutomountServiceAccountToken = desired.AutomountServiceAccountToken
	return r.Update(ctx, &existing)
}

// applyTickCronJob creates or updates the source's CronJob. Mirrors the
// Corpus sync-kick CronJob (reconcileSyncCronJob): the Job only KICKS the
// gateway, which reads the payload from the CR itself, so the CronJob carries
// nothing a tick could forge.
func (r *EventSourceReconciler) applyTickCronJob(ctx context.Context, source *corev1alpha1.EventSource, name string) error {
	log := logf.FromContext(ctx)
	cron := source.Spec.Cron

	var timeZone *string
	if cron.TimeZone != "" {
		timeZone = ptr.To(cron.TimeZone)
	}

	desired := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: source.Namespace,
			Labels: map[string]string{
				"core.controller-agent.dev/eventsource": source.Name,
			},
		},
		Spec: batchv1.CronJobSpec{
			Schedule: cron.Schedule,
			TimeZone: timeZone,
			Suspend:  ptr.To(cron.Suspend),
			// One tick is one event is one turn; a slow gateway must not have
			// a second tick for the same source stacked behind it.
			ConcurrencyPolicy: batchv1.ForbidConcurrent,
			// A missed window is skipped, not replayed: a backlog of ticks
			// after an outage would be a burst of identical turns.
			StartingDeadlineSeconds:    ptr.To(int64(300)),
			SuccessfulJobsHistoryLimit: ptr.To(int32(1)),
			FailedJobsHistoryLimit:     ptr.To(int32(3)),
			JobTemplate: batchv1.JobTemplateSpec{
				Spec: batchv1.JobSpec{
					// No retries, unlike the Corpus kick (whose pass is
					// idempotent): a tick the gateway accepted but whose
					// response was lost would be retried into a second turn.
					// A failed tick shows as a failed Job; the next comes on
					// schedule.
					BackoffLimit: ptr.To(int32(0)),
					Template: corev1.PodTemplateSpec{
						ObjectMeta: metav1.ObjectMeta{
							Labels: map[string]string{
								"core.controller-agent.dev/eventsource": source.Name,
							},
						},
						Spec: corev1.PodSpec{
							RestartPolicy:      corev1.RestartPolicyNever,
							ServiceAccountName: name,
							// The tick talks to the gateway, never the API server:
							// no API-audience token, only the gateway-audience one.
							AutomountServiceAccountToken: ptr.To(false),
							Volumes: []corev1.Volume{{
								Name: "tick-token",
								VolumeSource: corev1.VolumeSource{
									Projected: &corev1.ProjectedVolumeSource{
										Sources: []corev1.VolumeProjection{{
											ServiceAccountToken: &corev1.ServiceAccountTokenProjection{
												Audience:          TickTokenAudience,
												ExpirationSeconds: ptr.To(int64(tickTokenExpirySeconds)),
												Path:              tickTokenFile,
											},
										}},
									},
								},
							}},
							SecurityContext: &corev1.PodSecurityContext{
								RunAsNonRoot: ptr.To(true),
								RunAsUser:    ptr.To(jobRunAsUser),
								RunAsGroup:   ptr.To(jobRunAsGroup),
								SeccompProfile: &corev1.SeccompProfile{
									Type: corev1.SeccompProfileTypeRuntimeDefault,
								},
							},
							Containers: []corev1.Container{{
								Name:  "tick",
								Image: r.TickImage,
								Args:  tickArgs(source.Name, r.TickURL),
								VolumeMounts: []corev1.VolumeMount{{
									Name:      "tick-token",
									MountPath: tickTokenDir,
									ReadOnly:  true,
								}},
								SecurityContext: &corev1.SecurityContext{
									AllowPrivilegeEscalation: ptr.To(false),
									ReadOnlyRootFilesystem:   ptr.To(true),
									RunAsNonRoot:             ptr.To(true),
									Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
								},
							}},
						},
					},
				},
			},
		},
	}

	// Owned, so deleting the EventSource takes its CronJob with it; an orphan
	// would tick a source the gateway no longer knows (a 404 every time).
	if err := controllerutil.SetControllerReference(source, desired, r.Scheme); err != nil {
		return err
	}

	var existing batchv1.CronJob
	err := r.Get(ctx, types.NamespacedName{Namespace: source.Namespace, Name: name}, &existing)
	if apierrors.IsNotFound(err) {
		log.Info("Creating tick CronJob", "eventsource", source.Name, "schedule", cron.Schedule)
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}

	// Spec only: replacing the whole object would drop the status Kubernetes
	// keeps about the last schedule.
	existing.Spec = desired.Spec
	existing.Labels = desired.Labels
	return r.Update(ctx, &existing)
}

// tickArgs POSTs one tick. No shell: curl (>= 8.3) reads the projected token
// file into a variable and expands it into the header itself, so the token
// is never on a command line. -f makes a non-2xx fail the Job.
func tickArgs(source, tickURL string) []string {
	return []string{
		"-fsS", "--max-time", "30", "-X", "POST",
		"--variable", "token@" + tickTokenDir + "/" + tickTokenFile,
		"--expand-header", "Authorization: Bearer {{token:trim}}",
		fmt.Sprintf("%s/events/%s/tick", strings.TrimRight(tickURL, "/"), source),
	}
}

// deleteTickResources removes the source's CronJob and ServiceAccount if this
// source owns them. Only owned ones: a same-named object someone else created
// is not ours to delete. The ServiceAccount goes too, so a source that stops
// being cron leaves no identity behind that could still tick it.
func (r *EventSourceReconciler) deleteTickResources(ctx context.Context, source *corev1alpha1.EventSource) error {
	key := types.NamespacedName{Namespace: source.Namespace, Name: TickCronJobName(source.Name)}
	for _, obj := range []client.Object{&batchv1.CronJob{}, &corev1.ServiceAccount{}} {
		err := r.Get(ctx, key, obj)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !metav1.IsControlledBy(obj, source) {
			continue
		}
		logf.FromContext(ctx).Info("Removing tick resource", "eventsource", source.Name, "kind", fmt.Sprintf("%T", obj))
		if err := client.IgnoreNotFound(r.Delete(ctx, obj)); err != nil {
			return err
		}
	}
	return nil
}

// checkSenderCEL compiles a webhook source's sender expressions, returning a
// message for the first that does not compile ("" when all do). The gateway
// would otherwise discover it on the first delivery and drop every event.
func checkSenderCEL(sender *corev1alpha1.EventSender) string {
	if sender == nil {
		return ""
	}
	exprs := []struct {
		field string
		expr  string
		want  *cel.Type
	}{
		{"sender.loginFrom", sender.LoginFrom, cel.StringType},
		{"sender.isBotFrom", sender.IsBotFrom, cel.BoolType},
		{"sender.repositoryFrom", sender.RepositoryFrom, cel.StringType},
	}
	for _, e := range exprs {
		if e.expr == "" {
			continue
		}
		if err := eventcel.Compile(e.expr, e.want); err != nil {
			return fmt.Sprintf("%s: %v", e.field, err)
		}
	}
	return ""
}

func (r *EventSourceReconciler) secretReader() client.Reader {
	if r.SecretReader != nil {
		return r.SecretReader
	}
	return r.Client
}

// setReady records the Ready condition on source.Status (Reconcile writes it),
// requeueing after the given interval (0 for none).
func (r *EventSourceReconciler) setReady(
	ctx context.Context,
	source *corev1alpha1.EventSource,
	status metav1.ConditionStatus,
	reason, message string,
	requeueAfter time.Duration,
) (ctrl.Result, error) {
	if status == metav1.ConditionFalse {
		logf.FromContext(ctx).Info("EventSource not ready", "eventsource", source.Name, "reason", reason)
	}
	meta.SetStatusCondition(&source.Status.Conditions, metav1.Condition{
		Type:               eventSourceConditionReady,
		Status:             status,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: source.Generation,
	})
	return ctrl.Result{RequeueAfter: requeueAfter}, nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *EventSourceReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.EventSource{}).
		// The CronJob is ours; an edit to it should be corrected, and its
		// disappearance should bring it back.
		Owns(&batchv1.CronJob{}).
		Owns(&corev1.ServiceAccount{}).
		// Secrets are deliberately not watched: that would cache every Secret
		// in the cluster. A webhook source re-checks on a requeue instead.
		Named("eventsource").
		Complete(r)
}
