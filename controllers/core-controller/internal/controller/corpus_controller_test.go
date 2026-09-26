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
