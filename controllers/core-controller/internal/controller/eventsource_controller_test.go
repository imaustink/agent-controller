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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const testTickURL = "http://integration-gateway.default.svc:8080"

func cronSource(name, schedule string) *corev1alpha1.EventSource {
	return &corev1alpha1.EventSource{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1alpha1.EventSourceSpec{
			Cron: &corev1alpha1.CronSource{Schedule: schedule},
		},
	}
}

func webhookSource(name, secret, key string) *corev1alpha1.EventSource {
	return &corev1alpha1.EventSource{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1alpha1.EventSourceSpec{
			Webhook: &corev1alpha1.WebhookSource{
				Verify: corev1alpha1.WebhookVerify{
					Scheme:    corev1alpha1.WebhookVerifyBearer,
					SecretRef: corev1alpha1.SecretKeySelector{Name: secret, Key: key},
				},
			},
		},
	}
}

var _ = Describe("EventSource Controller", func() {
	ctx := context.Background()

	reconciler := func(tickURL string) *EventSourceReconciler {
		return &EventSourceReconciler{
			Client:    k8sClient,
			Scheme:    k8sClient.Scheme(),
			TickImage: "curlimages/curl:8.11.1",
			TickURL:   tickURL,
		}
	}

	reconcileWith := func(r *EventSourceReconciler, name string) reconcile.Result {
		res, err := r.Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Name: name, Namespace: "default"},
		})
		Expect(err).NotTo(HaveOccurred())
		return res
	}

	stored := func(name string) corev1alpha1.EventSource {
		var out corev1alpha1.EventSource
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: "default"}, &out)).To(Succeed())
		return out
	}

	ready := func(name string) *metav1.Condition {
		got := stored(name)
		cond := meta.FindStatusCondition(got.Status.Conditions, eventSourceConditionReady)
		Expect(cond).NotTo(BeNil(), "Ready condition on EventSource %s", name)
		return cond
	}

	cronJob := func(source string) (*batchv1.CronJob, error) {
		var cj batchv1.CronJob
		err := k8sClient.Get(ctx, types.NamespacedName{Name: TickCronJobName(source), Namespace: "default"}, &cj)
		return &cj, err
	}

	// envtest runs no garbage collector, so owned CronJobs are removed by hand.
	serviceAccount := func(name string) (*corev1.ServiceAccount, error) {
		var sa corev1.ServiceAccount
		err := k8sClient.Get(ctx, types.NamespacedName{Name: TickCronJobName(name), Namespace: "default"}, &sa)
		return &sa, err
	}

	// envtest runs no garbage collector, so owned objects are removed by hand.
	cleanup := func(source *corev1alpha1.EventSource) {
		_ = k8sClient.Delete(ctx, source)
		if cj, err := cronJob(source.Name); err == nil {
			_ = k8sClient.Delete(ctx, cj)
		}
		if sa, err := serviceAccount(source.Name); err == nil {
			_ = k8sClient.Delete(ctx, sa)
		}
	}

	Context("a cron source", func() {
		It("materializes a hardened, owned CronJob that ticks the gateway", func() {
			source := cronSource("nightly", "0 7 * * *")
			source.Spec.Cron.TimeZone = "America/Chicago"
			source.Spec.Cron.Suspend = true
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL+"/"), "nightly")

			cj, err := cronJob("nightly")
			Expect(err).NotTo(HaveOccurred())
			Expect(cj.Name).To(Equal("eventsource-nightly"))
			Expect(cj.Spec.Schedule).To(Equal("0 7 * * *"))
			Expect(cj.Spec.TimeZone).To(HaveValue(Equal("America/Chicago")))
			Expect(cj.Spec.Suspend).To(HaveValue(BeTrue()))
			Expect(cj.Spec.ConcurrencyPolicy).To(Equal(batchv1.ForbidConcurrent))
			Expect(cj.Spec.SuccessfulJobsHistoryLimit).To(HaveValue(Equal(int32(1))))
			Expect(cj.Spec.FailedJobsHistoryLimit).To(HaveValue(Equal(int32(3))))
			Expect(cj.Labels).To(HaveKeyWithValue("core.controller-agent.dev/eventsource", "nightly"))

			owner := metav1.GetControllerOf(cj)
			Expect(owner).NotTo(BeNil())
			Expect(owner.Kind).To(Equal("EventSource"))
			Expect(owner.Name).To(Equal("nightly"))

			sa, err := serviceAccount("nightly")
			Expect(err).NotTo(HaveOccurred())
			Expect(metav1.GetControllerOf(sa)).NotTo(BeNil())
			Expect(metav1.GetControllerOf(sa).Name).To(Equal("nightly"))
			Expect(sa.AutomountServiceAccountToken).To(HaveValue(BeFalse()))

			pod := cj.Spec.JobTemplate.Spec.Template.Spec
			Expect(pod.RestartPolicy).To(Equal(corev1.RestartPolicyNever))
			// The tick runs as the source's own ServiceAccount, with only a
			// gateway-audience projected token -- never an API-server one.
			Expect(pod.ServiceAccountName).To(Equal("eventsource-nightly"))
			Expect(pod.AutomountServiceAccountToken).To(HaveValue(BeFalse()))
			Expect(pod.Volumes).To(HaveLen(1))
			projection := pod.Volumes[0].Projected.Sources[0].ServiceAccountToken
			Expect(projection.Audience).To(Equal(TickTokenAudience))
			Expect(projection.ExpirationSeconds).To(HaveValue(Equal(int64(600))))
			Expect(pod.SecurityContext.RunAsNonRoot).To(HaveValue(BeTrue()))
			Expect(pod.SecurityContext.SeccompProfile.Type).To(Equal(corev1.SeccompProfileTypeRuntimeDefault))
			Expect(pod.Containers).To(HaveLen(1))

			c := pod.Containers[0]
			Expect(c.Image).To(Equal("curlimages/curl:8.11.1"))
			Expect(c.SecurityContext.ReadOnlyRootFilesystem).To(HaveValue(BeTrue()))
			Expect(c.SecurityContext.AllowPrivilegeEscalation).To(HaveValue(BeFalse()))
			Expect(c.SecurityContext.Capabilities.Drop).To(ConsistOf(corev1.Capability("ALL")))
			// -f: a non-2xx from the gateway fails the Job. The trailing slash
			// on the configured URL must not double up in the path.
			Expect(c.Args).To(ContainElement("-fsS"))
			Expect(c.Args).To(ContainElement("token@/var/run/secrets/eventsource/token"))
			Expect(c.Args).To(ContainElement("Authorization: Bearer {{token:trim}}"))
			Expect(c.Args[len(c.Args)-1]).To(Equal(testTickURL + "/events/nightly/tick"))
			Expect(c.Env).To(BeEmpty())
			Expect(c.VolumeMounts).To(ConsistOf(corev1.VolumeMount{
				Name: "tick-token", MountPath: "/var/run/secrets/eventsource", ReadOnly: true,
			}))

			Expect(stored("nightly").Status.CronJobName).To(Equal("eventsource-nightly"))
			cond := ready("nightly")
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal("Scheduled"))
		})

		It("updates the CronJob in place when the schedule changes", func() {
			source := cronSource("reschedule", "0 7 * * *")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "reschedule")
			before, err := cronJob("reschedule")
			Expect(err).NotTo(HaveOccurred())

			latest := stored("reschedule")
			latest.Spec.Cron.Schedule = "*/5 * * * *"
			Expect(k8sClient.Update(ctx, &latest)).To(Succeed())
			reconcileWith(reconciler(testTickURL), "reschedule")

			after, err := cronJob("reschedule")
			Expect(err).NotTo(HaveOccurred())
			Expect(after.Spec.Schedule).To(Equal("*/5 * * * *"))
			Expect(after.UID).To(Equal(before.UID), "updated, not recreated")
		})

		It("is TickNotConfigured, and owns no CronJob, without a tick URL", func() {
			source := cronSource("no-tick-url", "0 7 * * *")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			// First with a URL, so there is a CronJob to remove.
			reconcileWith(reconciler(testTickURL), "no-tick-url")
			_, err := cronJob("no-tick-url")
			Expect(err).NotTo(HaveOccurred())

			reconcileWith(reconciler(""), "no-tick-url")

			_, err = cronJob("no-tick-url")
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "CronJob should be deleted, got %v", err)
			_, err = serviceAccount("no-tick-url")
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "ServiceAccount should be deleted, got %v", err)
			Expect(stored("no-tick-url").Status.CronJobName).To(BeEmpty())
			cond := ready("no-tick-url")
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("TickNotConfigured"))
		})

		It("refuses to adopt a same-named ServiceAccount it does not own", func() {
			squatter := &corev1.ServiceAccount{
				ObjectMeta: metav1.ObjectMeta{Name: "eventsource-squatted", Namespace: "default"},
			}
			Expect(k8sClient.Create(ctx, squatter)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, squatter) }()

			source := cronSource("squatted", "0 7 * * *")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			_, err := reconciler(testTickURL).Reconcile(ctx, reconcile.Request{
				NamespacedName: types.NamespacedName{Name: "squatted", Namespace: "default"},
			})
			Expect(err).To(MatchError(ContainSubstring("not owned by EventSource squatted")))
			_, err = cronJob("squatted")
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "no CronJob may run as someone else's identity")
		})

		It("is InvalidSchedule, not a retry loop, when the API server rejects the schedule", func() {
			source := cronSource("bad-schedule", "not a schedule")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "bad-schedule")

			cond := ready("bad-schedule")
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("InvalidSchedule"))
		})

		It("deletes its CronJob when switched to a webhook", func() {
			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "switched-secret", Namespace: "default"},
				Data:       map[string][]byte{"token": []byte("s3cret")},
			}
			Expect(k8sClient.Create(ctx, secret)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, secret) }()

			source := cronSource("switched", "0 7 * * *")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "switched")
			_, err := cronJob("switched")
			Expect(err).NotTo(HaveOccurred())

			latest := stored("switched")
			latest.Spec = webhookSource("switched", "switched-secret", "token").Spec
			Expect(k8sClient.Update(ctx, &latest)).To(Succeed())
			reconcileWith(reconciler(testTickURL), "switched")

			_, err = cronJob("switched")
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "CronJob should be deleted, got %v", err)
			// No identity left behind that could still tick the source.
			_, err = serviceAccount("switched")
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "ServiceAccount should be deleted, got %v", err)
			Expect(stored("switched").Status.CronJobName).To(BeEmpty())
			Expect(ready("switched").Status).To(Equal(metav1.ConditionTrue))
		})
	})

	Context("a webhook source", func() {
		It("is Ready when its secret and key exist, and re-checks later", func() {
			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "hook-secret", Namespace: "default"},
				Data:       map[string][]byte{"secret": []byte("s3cret")},
			}
			Expect(k8sClient.Create(ctx, secret)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, secret) }()

			source := webhookSource("hook-ok", "hook-secret", "secret")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			res := reconcileWith(reconciler(testTickURL), "hook-ok")

			cond := ready("hook-ok")
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			// Secrets are not watched, so a requeue is the only way a later
			// deletion is noticed.
			Expect(res.RequeueAfter).To(BeNumerically(">", 0))
			_, err := cronJob("hook-ok")
			Expect(apierrors.IsNotFound(err)).To(BeTrue(), "a webhook source owns no CronJob")
		})

		It("is SecretNotFound when the secret does not exist", func() {
			source := webhookSource("hook-no-secret", "no-such-secret", "secret")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "hook-no-secret")

			cond := ready("hook-no-secret")
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("SecretNotFound"))
		})

		It("is SecretKeyMissing when the secret lacks the key", func() {
			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "hook-wrong-key", Namespace: "default"},
				Data:       map[string][]byte{"other": []byte("s3cret")},
			}
			Expect(k8sClient.Create(ctx, secret)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, secret) }()

			source := webhookSource("hook-key-missing", "hook-wrong-key", "secret")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "hook-key-missing")

			cond := ready("hook-key-missing")
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("SecretKeyMissing"))
		})

		It("becomes not Ready when its secret is deleted", func() {
			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "hook-goes-away", Namespace: "default"},
				Data:       map[string][]byte{"secret": []byte("s3cret")},
			}
			Expect(k8sClient.Create(ctx, secret)).To(Succeed())

			source := webhookSource("hook-lost-secret", "hook-goes-away", "secret")
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "hook-lost-secret")
			Expect(ready("hook-lost-secret").Status).To(Equal(metav1.ConditionTrue))

			Expect(k8sClient.Delete(ctx, secret)).To(Succeed())
			reconcileWith(reconciler(testTickURL), "hook-lost-secret")
			Expect(ready("hook-lost-secret").Reason).To(Equal("SecretNotFound"))
		})

		It("is InvalidCEL when a sender expression does not compile", func() {
			secret := &corev1.Secret{
				ObjectMeta: metav1.ObjectMeta{Name: "hook-cel-secret", Namespace: "default"},
				Data:       map[string][]byte{"secret": []byte("s3cret")},
			}
			Expect(k8sClient.Create(ctx, secret)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, secret) }()

			source := webhookSource("hook-bad-cel", "hook-cel-secret", "secret")
			source.Spec.Sender = &corev1alpha1.EventSender{
				Provider:  corev1alpha1.EventSenderProviderGitHub,
				LoginFrom: "body.sender.login",
				IsBotFrom: `body.sender.type ==`,
			}
			Expect(k8sClient.Create(ctx, source)).To(Succeed())
			defer cleanup(source)

			reconcileWith(reconciler(testTickURL), "hook-bad-cel")

			cond := ready("hook-bad-cel")
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("InvalidCEL"))
			Expect(cond.Message).To(ContainSubstring("sender.isBotFrom"))

			By("fixing the expression")
			latest := stored("hook-bad-cel")
			latest.Spec.Sender.IsBotFrom = `body.sender.type == "Bot"`
			Expect(k8sClient.Update(ctx, &latest)).To(Succeed())
			reconcileWith(reconciler(testTickURL), "hook-bad-cel")
			Expect(ready("hook-bad-cel").Status).To(Equal(metav1.ConditionTrue))
		})
	})
})
