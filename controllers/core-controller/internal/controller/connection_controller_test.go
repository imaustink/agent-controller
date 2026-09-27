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

// confluenceConnection is a minimal valid Connection: an authenticated route to
// one system, holding no scope of its own (ADR 0043).
func confluenceConnection(name string) *corev1alpha1.Connection {
	return &corev1alpha1.Connection{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1alpha1.ConnectionSpec{
			Provider:    "confluence",
			DisplayName: "Bitovi Confluence",
			Site:        &corev1alpha1.ConnectionSite{BaseURL: "https://example.atlassian.net/wiki"},
		},
	}
}

var _ = Describe("Connection Controller", func() {
	ctx := context.Background()

	Context("validation", func() {
		It("refuses a confluence connection with no site, which cannot be cited", func() {
			// baseURL is what every citation URL is built from. Without it the
			// material can be ingested and then only ever cited as links nobody
			// can open.
			conn := confluenceConnection("no-site")
			conn.Spec.Site = nil
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("a confluence Connection must set site.baseURL")))
		})

		It("refuses autoJoin on a non-slack connection", func() {
			// Joining is Slack-shaped and the only WRITE any driver performs.
			// Ignoring it elsewhere would leave an operator believing they had
			// enabled something.
			conn := confluenceConnection("autojoin-wrong-provider")
			conn.Spec.AutoJoin = true
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("autoJoin is only meaningful for a slack Connection")))
		})

		It("rejects an unknown provider", func() {
			conn := confluenceConnection("unknown-provider")
			conn.Spec.Provider = "notion"
			Expect(k8sClient.Create(ctx, conn)).To(HaveOccurred())
		})

		It("accepts a slack connection with no site", func() {
			// A channel is reached by id alone, so the confluence site rule
			// must not apply here.
			conn := confluenceConnection("slack-no-site")
			conn.Spec.Provider = providerSlack
			conn.Spec.Site = nil
			conn.Spec.AutoJoin = true
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})
	})

	// A Connection holds a credential; the material lives in the Corpora that
	// draw from it. Deleting one while Corpora remain would strand them, so
	// deletion BLOCKS rather than cascading — rotating a credential and
	// discarding a client's corpus are different intents, and only one of them
	// is reversible (ADR 0043 §4).
	Context("dependent corpora", func() {
		reconcileConnection := func(name string) {
			r := &ConnectionReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err := r.Reconcile(ctx, reconcile.Request{
				NamespacedName: types.NamespacedName{Name: name, Namespace: "default"},
			})
			Expect(err).NotTo(HaveOccurred())
		}

		It("counts what draws from it", func() {
			conn := confluenceConnection("counted")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, conn) }()

			corpus := corpusFor("counted", "counted-space")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())
			defer func() { _ = k8sClient.Delete(ctx, corpus) }()

			reconcileConnection("counted")

			var stored corev1alpha1.Connection
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "counted", Namespace: "default"}, &stored)).To(Succeed())
			Expect(stored.Status.Corpora).To(BeNumerically("==", 1))
		})

		It("blocks deletion while a Corpus still draws from it", func() {
			conn := confluenceConnection("blocked")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			reconcileConnection("blocked") // adds the finalizer

			corpus := corpusFor("blocked", "blocked-space")
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())

			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
			reconcileConnection("blocked")

			// Still present: the finalizer is held, and the reason says which
			// Corpora are in the way rather than just refusing.
			var stored corev1alpha1.Connection
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: "blocked", Namespace: "default"}, &stored)).To(Succeed())
			Expect(stored.Status.Conditions).To(ContainElement(
				HaveField("Reason", Equal("CorporaExist"))))

			Expect(k8sClient.Delete(ctx, corpus)).To(Succeed())
			reconcileConnection("blocked")

			// With nothing drawing from it, the finalizer lifts and the
			// deletion that was already requested completes.
			err := k8sClient.Get(ctx, types.NamespacedName{Name: "blocked", Namespace: "default"}, &stored)
			if err == nil {
				Expect(stored.Finalizers).To(BeEmpty())
			}
		})
	})
})
