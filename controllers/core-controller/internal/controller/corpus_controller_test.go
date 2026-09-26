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
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

const providerSlack = "slack"

// corpusFor is a minimal valid Corpus over the named Connection.
func corpusFor(connectionRef, name string) *corev1alpha1.Corpus {
	return &corev1alpha1.Corpus{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1alpha1.CorpusSpec{
			ConnectionRef: connectionRef,
			Description:   "The SNC client's Confluence space.",
			DisplayName:   "SNC Confluence",
			AllowedRoles:  []string{"reader"},
			Scope:         corev1alpha1.CorpusScope{Space: "SNC"},
		},
	}
}

var _ = Describe("Corpus Controller", func() {
	ctx := context.Background()

	reconcileCorpus := func(name string) {
		r := &CorpusReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Name: name, Namespace: "default"},
		})
		Expect(err).NotTo(HaveOccurred())
	}

	stored := func(name string) corev1alpha1.Corpus {
		var out corev1alpha1.Corpus
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: "default"}, &out)).To(Succeed())
		return out
	}

	// Scope is the security boundary (ADR 0038). What CEL can still enforce
	// without the provider — which now lives on the Connection — is enforced at
	// admission; the rest moved to the controller (ADR 0043).
	Context("scope shape", func() {
		It("rejects a corpus scoped to two things at once", func() {
			corpus := corpusFor("anything", "scope-two-things")
			corpus.Spec.Scope.Channel = "C6RQKL5BK"
			Expect(k8sClient.Create(ctx, corpus)).To(
				MatchError(ContainSubstring("exactly one unit")),
				"a widened scope is the failure this validation exists to catch")
		})

		It("rejects a corpus with no scope at all", func() {
			corpus := corpusFor("anything", "scope-none")
			corpus.Spec.Scope = corev1alpha1.CorpusScope{}
			Expect(k8sClient.Create(ctx, corpus)).To(HaveOccurred())
		})

		It("requires a connectionRef", func() {
			corpus := corpusFor("", "no-connection-ref")
			Expect(k8sClient.Create(ctx, corpus)).To(HaveOccurred())
		})
	})

	Context("resolution from its Connection", func() {
		It("inherits provider and identityProviders into status", func() {
			// Published into status so both engines keep watching ONE kind,
			// rather than each growing a join across two resources.
			conn := confluenceConnection("inherit-src")
			conn.Spec.IdentityProviders = []string{"atlassian"}
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, conn) }()

			corpus := corpusFor("inherit-src", "inherits")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("inherits")

			got := stored("inherits")
			Expect(got.Status.Provider).To(Equal("confluence"))
			Expect(got.Status.IdentityProviders).To(Equal([]string{"atlassian"}))
			Expect(got.Status.Collection).To(Equal(CorpusCollectionName("default", "inherits")))
		})

		It("degrades when its connectionRef does not resolve", func() {
			corpus := corpusFor("no-such-connection", "dangling")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("dangling")

			// Not an error to retry into: a watch brings us back the moment the
			// Connection appears.
			Expect(stored("dangling").Status.Conditions).To(ContainElement(
				HaveField("Reason", Equal("ConnectionNotFound"))))
		})

		It("clears an inherited provider when it stops resolving", func() {
			// A stale claim would let a consumer act on a Connection this
			// Corpus no longer validly references.
			conn := confluenceConnection("goes-away")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			corpus := corpusFor("goes-away", "was-resolved")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("was-resolved")
			Expect(stored("was-resolved").Status.Provider).To(Equal("confluence"))

			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
			reconcileCorpus("was-resolved")
			Expect(stored("was-resolved").Status.Provider).To(BeEmpty())
		})
	})

	// The provider-specific shape check CEL can no longer do, because the
	// provider is on another resource.
	Context("scope must match the provider", func() {
		It("degrades a confluence corpus scoped to a channel", func() {
			conn := confluenceConnection("mismatch-src")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, conn) }()

			corpus := corpusFor("mismatch-src", "mismatched")
			corpus.Spec.Scope = corev1alpha1.CorpusScope{Channel: "C6RQKL5BK"}
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("mismatched")

			Expect(stored("mismatched").Status.Conditions).To(ContainElement(
				HaveField("Reason", Equal("ScopeMismatch"))))
		})
	})

	// The credential holder decides what the credential may pull (ADR 0043 §3).
	Context("the Connection's allowedScopes cap", func() {
		It("refuses a subset the Connection does not permit", func() {
			conn := confluenceConnection("capped")
			conn.Spec.AllowedScopes = &corev1alpha1.ConnectionAllowedScopes{Spaces: []string{"PERMITTED"}}
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, conn) }()

			corpus := corpusFor("capped", "outside-cap")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed()) // scope.space is "SNC"
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("outside-cap")

			Expect(stored("outside-cap").Status.Conditions).To(ContainElement(
				HaveField("Reason", Equal("OutsideAllowedScopes"))))
		})

		It("permits a subset inside the cap", func() {
			conn := confluenceConnection("capped-ok")
			conn.Spec.AllowedScopes = &corev1alpha1.ConnectionAllowedScopes{Spaces: []string{"SNC"}}
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, conn) }()

			corpus := corpusFor("capped-ok", "inside-cap")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("inside-cap")
			Expect(stored("inside-cap").Status.Provider).To(Equal("confluence"))
		})

		It("permits anything when the Connection sets no cap", func() {
			// An absent allowlist means no cap, not an empty one: the cap is
			// opt-in, and reading it the other way would break every Connection
			// that never set one.
			conn := confluenceConnection("uncapped")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, conn) }()

			corpus := corpusFor("uncapped", "no-cap-anything")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileCorpus("no-cap-anything")
			Expect(stored("no-cap-anything").Status.Provider).To(Equal("confluence"))
		})
	})

	Context("sync validation", func() {
		It("rejects webhook mode without a reconcile interval", func() {
			corpus := corpusFor("anything", "webhook-no-interval")
			corpus.Spec.Sync = &corev1alpha1.CorpusSync{Mode: corev1alpha1.CorpusSyncWebhook}
			Expect(k8sClient.Create(ctx, corpus)).To(
				MatchError(ContainSubstring("reconcileInterval is required")))
		})

		It("accepts mode none without one, since it indexes nothing", func() {
			corpus := corpusFor("anything", "sync-none")
			corpus.Spec.Sync = &corev1alpha1.CorpusSync{Mode: corev1alpha1.CorpusSyncNone}
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			Expect(k8sClient.Delete(ctx, corpus)).To(Succeed())
		})
	})
})

// The periodic reconcile is a Kubernetes object rather than a timer inside a
// process. It used to be a setTimeout loop in the broker, which meant a pod
// restarting more often than the interval could reconcile far less than
// configured — or never — with nothing to show for it (ADR 0038 §4).
var _ = Describe("Corpus sync CronJob", func() {
	ctx := context.Background()

	reconcileCorpus := func(name string) {
		r := &CorpusReconciler{
			Client:          k8sClient,
			Scheme:          k8sClient.Scheme(),
			SyncKickImage:   "curlimages/curl:8.11.1",
			BrokerURL:       "http://connection-broker:8080",
			SyncTokenSecret: "connection-broker-sync-tokens",
		}
		_, err := r.Reconcile(ctx, reconcile.Request{
			NamespacedName: types.NamespacedName{Name: name, Namespace: "default"},
		})
		Expect(err).NotTo(HaveOccurred())
	}

	cronJob := func(corpus string) (*batchv1.CronJob, error) {
		var cj batchv1.CronJob
		err := k8sClient.Get(ctx,
			types.NamespacedName{Name: SyncCronJobName(corpus), Namespace: "default"}, &cj)
		return &cj, err
	}

	syncing := func(connectionRef, name string, interval time.Duration) *corev1alpha1.Corpus {
		corpus := corpusFor(connectionRef, name)
		corpus.Spec.Sync = &corev1alpha1.CorpusSync{
			Mode:              corev1alpha1.CorpusSyncPoll,
			ReconcileInterval: &metav1.Duration{Duration: interval},
		}
		return corpus
	}

	It("creates a CronJob the Corpus owns", func() {
		conn := confluenceConnection("cron-src")
		Expect(k8sClient.Create(ctx, conn)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, conn) }()

		corpus := syncing("cron-src", "cron-owned", 6*time.Hour)
		Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, corpus) }()

		reconcileCorpus("cron-owned")

		cj, err := cronJob("cron-owned")
		Expect(err).NotTo(HaveOccurred())
		Expect(cj.Spec.Schedule).To(Equal("0 */6 * * *"))

		// Owned, so deleting the Corpus takes it along. Nothing else cleans
		// these up, and an orphan would go on kicking a corpus that is gone.
		Expect(cj.OwnerReferences).To(HaveLen(1))
		Expect(cj.OwnerReferences[0].Name).To(Equal("cron-owned"))
		Expect(*cj.OwnerReferences[0].Controller).To(BeTrue())
	})

	It("forbids concurrent passes", func() {
		conn := confluenceConnection("cron-conc")
		Expect(k8sClient.Create(ctx, conn)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, conn) }()

		corpus := syncing("cron-conc", "cron-forbid", time.Hour)
		Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, corpus) }()

		reconcileCorpus("cron-forbid")

		cj, err := cronJob("cron-forbid")
		Expect(err).NotTo(HaveOccurred())
		// Two concurrent full passes can each conclude the other's freshly
		// written chunks are absent, and a full pass deletes what it believes
		// absent.
		Expect(cj.Spec.ConcurrencyPolicy).To(Equal(batchv1.ForbidConcurrent))
	})

	It("creates no CronJob for a Corpus that indexes nothing", func() {
		conn := confluenceConnection("cron-none-src")
		Expect(k8sClient.Create(ctx, conn)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, conn) }()

		corpus := corpusFor("cron-none-src", "cron-none")
		corpus.Spec.Sync = &corev1alpha1.CorpusSync{Mode: corev1alpha1.CorpusSyncNone}
		Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, corpus) }()

		reconcileCorpus("cron-none")

		_, err := cronJob("cron-none")
		Expect(err).To(HaveOccurred())
	})

	It("removes the CronJob when sync is turned off", func() {
		// Leaving it would keep reconciling something the operator switched off.
		conn := confluenceConnection("cron-off-src")
		Expect(k8sClient.Create(ctx, conn)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, conn) }()

		corpus := syncing("cron-off-src", "cron-off", time.Hour)
		Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, corpus) }()
		reconcileCorpus("cron-off")
		Expect(cronJob("cron-off")).Error().NotTo(HaveOccurred())

		var stored corev1alpha1.Corpus
		Expect(k8sClient.Get(ctx,
			types.NamespacedName{Name: "cron-off", Namespace: "default"}, &stored)).To(Succeed())
		stored.Spec.Sync = &corev1alpha1.CorpusSync{Mode: corev1alpha1.CorpusSyncNone}
		Expect(k8sClient.Update(ctx, &stored)).To(Succeed())

		reconcileCorpus("cron-off")
		_, err := cronJob("cron-off")
		Expect(err).To(HaveOccurred())
	})

	It("updates the schedule when the interval changes", func() {
		conn := confluenceConnection("cron-edit-src")
		Expect(k8sClient.Create(ctx, conn)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, conn) }()

		corpus := syncing("cron-edit-src", "cron-edit", 6*time.Hour)
		Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
		defer func() { _ = k8sClient.Delete(ctx, corpus) }()
		reconcileCorpus("cron-edit")

		var stored corev1alpha1.Corpus
		Expect(k8sClient.Get(ctx,
			types.NamespacedName{Name: "cron-edit", Namespace: "default"}, &stored)).To(Succeed())
		stored.Spec.Sync.ReconcileInterval = &metav1.Duration{Duration: 30 * time.Minute}
		Expect(k8sClient.Update(ctx, &stored)).To(Succeed())

		reconcileCorpus("cron-edit")
		cj, err := cronJob("cron-edit")
		Expect(err).NotTo(HaveOccurred())
		Expect(cj.Spec.Schedule).To(Equal("*/30 * * * *"))
	})
})

// cronSchedule is a plain unit test: cron cannot express every interval
// honestly, and what it does with the ones it cannot is the interesting part.
func TestCronSchedule(t *testing.T) {
	corpus := func(d time.Duration, mode corev1alpha1.CorpusSyncMode) *corev1alpha1.Corpus {
		c := &corev1alpha1.Corpus{}
		c.Spec.Sync = &corev1alpha1.CorpusSync{Mode: mode}
		if d > 0 {
			c.Spec.Sync.ReconcileInterval = &metav1.Duration{Duration: d}
		}
		return c
	}

	cases := []struct {
		name string
		in   *corev1alpha1.Corpus
		want string
		ok   bool
	}{
		{"six hours", corpus(6*time.Hour, corev1alpha1.CorpusSyncPoll), "0 */6 * * *", true},
		{"thirty minutes", corpus(30*time.Minute, corev1alpha1.CorpusSyncPoll), "*/30 * * * *", true},
		// Rounded DOWN, so it reconciles more often than asked rather than
		// less: cron cannot say "every 90 minutes" and pretending otherwise
		// produces a schedule that drifts from what the CR claims.
		{"ninety minutes", corpus(90*time.Minute, corev1alpha1.CorpusSyncPoll), "0 */1 * * *", true},
		{"a week clamps to daily", corpus(7*24*time.Hour, corev1alpha1.CorpusSyncPoll), "0 0 * * *", true},
		{"mode none", corpus(time.Hour, corev1alpha1.CorpusSyncNone), "", false},
		{"no interval", corpus(0, corev1alpha1.CorpusSyncPoll), "", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := cronSchedule(tc.in)
			if ok != tc.ok || got != tc.want {
				t.Fatalf("cronSchedule = %q, %v; want %q, %v", got, ok, tc.want, tc.ok)
			}
		})
	}
}

func TestEnvSuffixMatchesTheBrokersConvention(t *testing.T) {
	// The broker reads SYNC_TOKEN_<CORPUS>, upper-cased with dashes as
	// underscores. A mismatch here means the kick Job authenticates with an
	// unset variable and every scheduled pass 401s.
	if got := envSuffix("snc-confluence"); got != "SNC_CONFLUENCE" {
		t.Fatalf("envSuffix = %q", got)
	}
}
