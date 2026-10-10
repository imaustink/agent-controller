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
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/utils/ptr"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	logf "sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const corpusConditionReady = "Ready"

// reasonScopeMismatch is the Degraded reason for a scope whose shape does not
// match its Connection's provider — the check CEL can no longer make, because
// the provider now lives on another resource.
const reasonScopeMismatch = "ScopeMismatch"

// CorpusCollectionName is the vector-store collection a Corpus owns.
//
// Storage is per-Corpus rather than per-KnowledgeBase (ADR 0039 §1), so a
// Corpus shared by several knowledge bases is embedded once and recomposing a
// knowledge base costs no re-indexing.
//
// Namespace and name both appear because collections are global in the vector
// store while Corpus names are only unique per namespace. Without the
// namespace, two same-named Corpora in different namespaces would silently
// share one collection — a cross-tenant leak of exactly the kind ADR 0039 §1
// argues the per-collection split exists to prevent.
func CorpusCollectionName(namespace, name string) string {
	return fmt.Sprintf("corpus_%s_%s", namespace, name)
}

// CorpusReconciler reconciles a Corpus object
type CorpusReconciler struct {
	client.Client
	Scheme *runtime.Scheme

	// SyncKickImage runs the CronJob's one command: ask the broker for a pass.
	// Any image with curl and a shell will do.
	SyncKickImage string
	// BrokerURL is the in-cluster address of the connection-broker Service.
	BrokerURL string
	// SyncTokenSecret holds SYNC_TOKEN_<CORPUS> entries, mounted into the kick
	// Job so it can authenticate as that corpus's sync worker.
	SyncTokenSecret string
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=corpora,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=corpora/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=corpora/finalizers,verbs=update
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=connections,verbs=get;list;watch
// +kubebuilder:rbac:groups=batch,resources=cronjobs,verbs=get;list;watch;create;update;patch;delete

// Reconcile assigns a Corpus its collection and resolves what it inherits from
// its Connection.
//
// The resolution is the reason this controller does more than its predecessor.
// A Corpus names a Connection; the provider and the identity providers live
// there (ADR 0043). Publishing them into status means both engines keep
// watching ONE kind to build their catalogs, instead of each growing a join
// across two resources — the split stays here rather than spreading.
//
// Two checks moved here from admission, because CEL cannot read another
// resource and the provider is no longer on this object:
//
//   - the scope's shape must match the provider (a confluence Corpus wants a
//     space, a slack one a channel)
//   - the scope must be inside the Connection's allowedScopes, when it sets one
//
// Both fail the Corpus as Degraded rather than deleting or mutating it, and
// the broker refuses to bind a Corpus it cannot make sense of anyway, so a
// mis-shaped one is inert in both places rather than half-served in one.
//
// Credential presence is still deliberately NOT validated: this controller
// holds no RBAC on Secrets, and confirming one exists would mean granting read
// over Secrets to buy a nicety. A missing credential surfaces as a failed sync.
func (r *CorpusReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var corpus corev1alpha1.Corpus
	if err := r.Get(ctx, req.NamespacedName, &corpus); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	collection := CorpusCollectionName(corpus.Namespace, corpus.Name)
	if corpus.Status.Collection != collection {
		log.Info("Assigned Corpus a vector-store collection",
			"corpus", corpus.Name, "collection", collection)
	}
	corpus.Status.Collection = collection
	corpus.Status.ObservedGeneration = corpus.Generation

	var connection corev1alpha1.Connection
	err := r.Get(ctx, types.NamespacedName{Namespace: corpus.Namespace, Name: corpus.Spec.ConnectionRef}, &connection)
	if apierrors.IsNotFound(err) {
		// Not an error to retry into: the Connection may simply not exist yet,
		// and a watch brings us back the moment it does.
		return r.degrade(ctx, &corpus, "ConnectionNotFound",
			fmt.Sprintf("connectionRef %q does not resolve", corpus.Spec.ConnectionRef))
	}
	if err != nil {
		return ctrl.Result{}, err
	}

	if reason, message := checkScope(&corpus, &connection); reason != "" {
		return r.degrade(ctx, &corpus, reason, message)
	}

	// Inherited from the Connection so consumers need not join (ADR 0043 §1).
	corpus.Status.Provider = connection.Spec.Provider
	corpus.Status.IdentityProviders = connection.Spec.IdentityProviders

	// The periodic reconcile is a CronJob this Corpus owns, not a timer inside
	// a process (see reconcileSyncCronJob).
	if err := r.reconcileSyncCronJob(ctx, &corpus); err != nil {
		return ctrl.Result{}, err
	}

	meta.SetStatusCondition(&corpus.Status.Conditions, metav1.Condition{
		Type:   corpusConditionReady,
		Status: metav1.ConditionTrue,
		Reason: "Accepted",
		Message: fmt.Sprintf("scoped %s corpus over connection %s; indexes into %s",
			connection.Spec.Provider, connection.Name, collection),
		ObservedGeneration: corpus.Generation,
	})

	if err := r.Status().Update(ctx, &corpus); err != nil {
		return ctrl.Result{}, err
	}
	return ctrl.Result{}, nil
}

// degrade records why this Corpus cannot be served and stops.
//
// The provider and identityProviders are CLEARED rather than left at their last
// values: they are a claim about what this Corpus resolves to, and continuing
// to publish a stale claim would let a consumer act on a Connection this Corpus
// no longer validly references.
func (r *CorpusReconciler) degrade(
	ctx context.Context,
	corpus *corev1alpha1.Corpus,
	reason, message string,
) (ctrl.Result, error) {
	corpus.Status.Provider = ""
	corpus.Status.IdentityProviders = nil
	meta.SetStatusCondition(&corpus.Status.Conditions, metav1.Condition{
		Type:               corpusConditionReady,
		Status:             metav1.ConditionFalse,
		Reason:             reason,
		Message:            message,
		ObservedGeneration: corpus.Generation,
	})
	return ctrl.Result{}, r.Status().Update(ctx, corpus)
}

// checkScope enforces what CEL no longer can: that the scope matches the
// provider, and that it is inside whatever the Connection permits.
func checkScope(corpus *corev1alpha1.Corpus, connection *corev1alpha1.Connection) (reason, message string) {
	scope := corpus.Spec.Scope

	unit, allowed := "", []string(nil)
	switch connection.Spec.Provider {
	case "confluence":
		unit = scope.Space
		if connection.Spec.AllowedScopes != nil {
			allowed = connection.Spec.AllowedScopes.Spaces
		}
		if unit == "" {
			return reasonScopeMismatch, "a confluence Corpus must set scope.space"
		}
	case "slack":
		unit = scope.Channel
		if connection.Spec.AllowedScopes != nil {
			allowed = connection.Spec.AllowedScopes.Channels
		}
		if unit == "" {
			return reasonScopeMismatch, "a slack Corpus must set scope.channel"
		}
	case "gdrive":
		unit = scope.FolderID
		if connection.Spec.AllowedScopes != nil {
			allowed = connection.Spec.AllowedScopes.FolderIDs
		}
		if unit == "" {
			return reasonScopeMismatch, "a gdrive Corpus must set scope.folderID"
		}
	default:
		return "UnknownProvider", fmt.Sprintf("connection %s has provider %q, which no driver implements",
			connection.Name, connection.Spec.Provider)
	}

	// An empty allowlist means the Connection set no cap for this provider, not
	// that it permits nothing — the cap is opt-in (ADR 0043 §3).
	if len(allowed) > 0 && !slices.Contains(allowed, unit) {
		return "OutsideAllowedScopes", fmt.Sprintf(
			"connection %s does not permit %q; add it to spec.allowedScopes to allow it",
			connection.Name, unit)
	}
	return "", ""
}

// SyncCronJobName is the CronJob a Corpus owns.
func SyncCronJobName(corpus string) string { return "corpus-sync-" + corpus }

// reconcileSyncCronJob makes the periodic reconcile a Kubernetes object rather
// than a timer inside a process.
//
// It used to be a setTimeout loop in the broker, which meant a pod that
// restarted more often than the interval could reconcile far less than
// configured — or never — and nothing would say so. A CronJob's schedule lives
// in the API server, so a restart costs nothing, a missed run is visible in
// `kubectl get cronjob`, and the backstop ADR 0038 §4 depends on stops being a
// promise the broker makes to itself.
//
// The Job KICKS the broker rather than doing the work. The broker already
// holds the drivers, the credentials, the writer and the embedder; a second
// implementation of a sync pass is how the two drift, and this one would be the
// copy nobody runs locally.
//
// A Corpus that indexes nothing gets no CronJob, and one that had its sync
// turned off has its CronJob removed — leaving it would keep reconciling
// something the operator switched off.
func (r *CorpusReconciler) reconcileSyncCronJob(ctx context.Context, corpus *corev1alpha1.Corpus) error {
	log := logf.FromContext(ctx)
	name := types.NamespacedName{Namespace: corpus.Namespace, Name: SyncCronJobName(corpus.Name)}

	schedule, ok := cronSchedule(corpus)
	if !ok {
		var existing batchv1.CronJob
		if err := r.Get(ctx, name, &existing); err == nil {
			log.Info("Removing sync CronJob for a Corpus that no longer indexes", "corpus", corpus.Name)
			return client.IgnoreNotFound(r.Delete(ctx, &existing))
		}
		return nil
	}

	desired := &batchv1.CronJob{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name.Name,
			Namespace: name.Namespace,
			Labels: map[string]string{
				"core.controller-agent.dev/corpus": corpus.Name,
			},
		},
		Spec: batchv1.CronJobSpec{
			Schedule: schedule,
			// The same rule the in-process scheduler enforced, now enforced by
			// Kubernetes: two concurrent full passes can each conclude the
			// other's freshly written chunks are absent, and a full pass
			// deletes what it believes absent.
			ConcurrencyPolicy: batchv1.ForbidConcurrent,
			// A missed window is caught by the next one. Rerunning a backlog
			// would stampede the source with no benefit, since each pass
			// already reconciles the whole corpus.
			StartingDeadlineSeconds:    ptr.To(int64(300)),
			SuccessfulJobsHistoryLimit: ptr.To(int32(1)),
			FailedJobsHistoryLimit:     ptr.To(int32(3)),
			JobTemplate: batchv1.JobTemplateSpec{
				Spec: batchv1.JobSpec{
					BackoffLimit: ptr.To(int32(2)),
					Template: corev1.PodTemplateSpec{
						Spec: corev1.PodSpec{
							RestartPolicy: corev1.RestartPolicyNever,
							Containers: []corev1.Container{{
								Name:  "kick",
								Image: r.SyncKickImage,
								Args:  syncKickArgs(corpus.Name, r.BrokerURL),
								EnvFrom: []corev1.EnvFromSource{{
									SecretRef: &corev1.SecretEnvSource{
										LocalObjectReference: corev1.LocalObjectReference{Name: r.SyncTokenSecret},
										Optional:             ptr.To(true),
									},
								}},
							}},
						},
					},
				},
			},
		},
	}

	// Owned, so deleting the Corpus takes its CronJob with it. Nothing else
	// cleans these up, and an orphan would go on kicking a corpus that no
	// longer exists.
	if err := controllerutil.SetControllerReference(corpus, desired, r.Scheme); err != nil {
		return err
	}

	var existing batchv1.CronJob
	err := r.Get(ctx, name, &existing)
	if apierrors.IsNotFound(err) {
		log.Info("Creating sync CronJob", "corpus", corpus.Name, "schedule", schedule)
		return r.Create(ctx, desired)
	}
	if err != nil {
		return err
	}

	// Spec only: an update that replaced the whole object would drop the
	// status Kubernetes keeps about the last schedule.
	existing.Spec = desired.Spec
	existing.Labels = desired.Labels
	return r.Update(ctx, &existing)
}

// cronSchedule turns a reconcileInterval into a cron expression.
//
// Deliberately coarse. Cron cannot express "every 90 minutes" honestly, and
// pretending otherwise produces a schedule that drifts from what the CR says —
// so an interval is rounded DOWN to something cron states exactly, which
// reconciles more often than asked rather than less. Reconciling is the
// backstop; erring toward more of it is the safe direction.
func cronSchedule(corpus *corev1alpha1.Corpus) (string, bool) {
	sync := corpus.Spec.Sync
	if sync == nil || sync.Mode == corev1alpha1.CorpusSyncNone || sync.ReconcileInterval == nil {
		return "", false
	}

	interval := sync.ReconcileInterval.Duration
	switch {
	case interval <= 0:
		return "", false
	case interval < time.Hour:
		minutes := max(int(interval.Minutes()), 1)
		return fmt.Sprintf("*/%d * * * *", min(minutes, 59)), true
	case interval < 24*time.Hour:
		return fmt.Sprintf("0 */%d * * *", min(int(interval.Hours()), 23)), true
	default:
		return "0 0 * * *", true
	}
}

// syncKickArgs asks the broker to run a pass. Kept as a shell command rather
// than a bespoke image so the CronJob needs nothing this repo has to build.
func syncKickArgs(corpus, brokerURL string) []string {
	return []string{
		"/bin/sh", "-c",
		fmt.Sprintf(
			`set -e; curl -sS -X POST -o /dev/stderr -w '%%{http_code}' `+
				`-H "Authorization: Bearer $SYNC_TOKEN_%s" `+
				`%s/corpora/%s/sync | grep -qE '^(200|409)$$'`,
			envSuffix(corpus), brokerURL, corpus,
		),
	}
}

// envSuffix matches the broker's own SYNC_TOKEN_<CORPUS> convention, where a
// corpus name is upper-cased and dashes become underscores.
func envSuffix(corpus string) string {
	out := make([]rune, 0, len(corpus))
	for _, r := range corpus {
		switch {
		case r == '-' || r == '.':
			out = append(out, '_')
		case r >= 'a' && r <= 'z':
			out = append(out, r-32)
		default:
			out = append(out, r)
		}
	}
	return string(out)
}

// SetupWithManager sets up the controller with the Manager.
func (r *CorpusReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&corev1alpha1.Corpus{}).
		// The CronJob is ours; an edit to it should be corrected, and its
		// disappearance should bring it back.
		Owns(&batchv1.CronJob{}).
		// A Corpus inherits from its Connection, so a Connection edit — a
		// provider change, a tightened allowlist — has to re-resolve every
		// Corpus over it. Without this they would keep publishing what the
		// Connection used to say.
		Watches(
			&corev1alpha1.Connection{},
			handler.EnqueueRequestsFromMapFunc(r.corporaForConnection),
			builder.WithPredicates(),
		).
		Named("corpus").
		Complete(r)
}

func (r *CorpusReconciler) corporaForConnection(ctx context.Context, obj client.Object) []reconcile.Request {
	var corpora corev1alpha1.CorpusList
	if err := r.List(ctx, &corpora, client.InNamespace(obj.GetNamespace())); err != nil {
		return nil
	}

	var requests []reconcile.Request
	for _, corpus := range corpora.Items {
		if corpus.Spec.ConnectionRef != obj.GetName() {
			continue
		}
		requests = append(requests, reconcile.Request{
			NamespacedName: types.NamespacedName{Namespace: corpus.Namespace, Name: corpus.Name},
		})
	}
	return requests
}
