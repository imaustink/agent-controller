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

// providerSlack is the provider name these specs switch a fixture to. A
// constant only because it now appears in several specs.
const providerSlack = "slack"

// confluenceConnection is a minimal valid Connection; each test mutates its
// own copy rather than sharing one across specs.
func confluenceConnection(name string) *corev1alpha1.Connection {
	return &corev1alpha1.Connection{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1alpha1.ConnectionSpec{
			Provider:     "confluence",
			Description:  "The SNC client's Confluence space.",
			DisplayName:  "SNC Confluence",
			AllowedRoles: []string{"reader"},
			Scope:        corev1alpha1.ConnectionScope{Space: "SNC"},
			Site: &corev1alpha1.ConnectionSite{
				BaseURL: "https://example.atlassian.net/wiki",
			},
		},
	}
}

var _ = Describe("Connection Controller", func() {
	ctx := context.Background()

	// A Connection's scope is its security boundary (ADR 0038): everything the
	// broker does is constrained to it, so a mismatched or over-broad scope has
	// to fail at ADMISSION rather than be caught by a driver at run time. These
	// specs exercise the CEL rules that make that true.
	Context("scope validation", func() {
		It("refuses autoJoin on a non-slack connection", func() {
			// Joining is a Slack-shaped action and the only WRITE any driver
			// performs. Silently ignoring it elsewhere would leave an operator
			// believing they had enabled something.
			conn := confluenceConnection("autojoin-wrong-provider")
			conn.Spec.AutoJoin = true
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("autoJoin is only meaningful for a slack Connection")))
		})

		It("accepts autoJoin on a slack connection", func() {
			conn := confluenceConnection("autojoin-slack")
			conn.Spec.Provider = providerSlack
			conn.Spec.Scope = corev1alpha1.ConnectionScope{Channel: "C123ABC"}
			conn.Spec.Site = nil
			conn.Spec.AutoJoin = true
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})

		It("refuses a confluence connection with no site, which cannot be cited", func() {
			// baseURL is what every citation URL is built from. Without it the
			// connection can be ingested and then only ever cited as links
			// nobody can open, which is close to not citing at all.
			conn := confluenceConnection("no-site-confluence")
			conn.Spec.Site = nil
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("a confluence Connection must set site.baseURL")))
		})

		It("accepts a confluence connection scoped to a space", func() {
			conn := confluenceConnection("scope-ok-confluence")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})

		It("accepts two slack connections over the same channel-less secret", func() {
			for _, name := range []string{"snc-slack-eng", "snc-slack-general"} {
				conn := confluenceConnection(name)
				conn.Spec.Provider = providerSlack
				conn.Spec.Scope = corev1alpha1.ConnectionScope{Channel: "C" + name}
				// A Slack channel is reached without site-level coordinates.
				conn.Spec.Site = nil
				Expect(k8sClient.Create(ctx, conn)).To(Succeed(),
					"same-provider repeats are ordinary, not an error")
				defer func() { Expect(k8sClient.Delete(ctx, conn)).To(Succeed()) }()
			}
		})

		It("rejects a slack connection scoped to a confluence space", func() {
			conn := confluenceConnection("scope-wrong-kind")
			conn.Spec.Provider = providerSlack
			// Scope left as {Space: "SNC"} — the wrong shape for slack.
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("a slack Connection must set scope.channel")))
		})

		It("rejects a connection scoped to two things at once", func() {
			conn := confluenceConnection("scope-two-things")
			conn.Spec.Scope.Channel = "C6RQKL5BK"
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("a confluence Connection must set scope.space and nothing else")),
				"a widened scope is the failure this validation exists to catch")
		})

		It("rejects a connection with no scope at all", func() {
			conn := confluenceConnection("scope-empty")
			conn.Spec.Scope = corev1alpha1.ConnectionScope{}
			Expect(k8sClient.Create(ctx, conn)).To(HaveOccurred())
		})

		It("rejects an unknown provider", func() {
			conn := confluenceConnection("provider-unknown")
			conn.Spec.Provider = "sharepoint"
			Expect(k8sClient.Create(ctx, conn)).To(HaveOccurred())
		})
	})

	// Webhooks are lossy — Drive channels expire, Slack drops events, a
	// Confluence webhook can be disabled by a space admin — so the full
	// reconcile is the source of truth and its interval is not optional
	// (ADR 0038 §4).
	Context("sync validation", func() {
		It("rejects webhook mode without a reconcile interval", func() {
			conn := confluenceConnection("sync-webhook-no-interval")
			conn.Spec.Sync = &corev1alpha1.ConnectionSync{
				Mode: corev1alpha1.ConnectionSyncWebhook,
			}
			Expect(k8sClient.Create(ctx, conn)).To(
				MatchError(ContainSubstring("sync.reconcileInterval is required")))
		})

		It("accepts webhook mode with one", func() {
			conn := confluenceConnection("sync-webhook-ok")
			conn.Spec.Sync = &corev1alpha1.ConnectionSync{
				Mode:              corev1alpha1.ConnectionSyncWebhook,
				ReconcileInterval: &metav1.Duration{Duration: 6 * 60 * 60 * 1e9},
			}
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})

		It("accepts mode none without one, since it indexes nothing", func() {
			conn := confluenceConnection("sync-none-ok")
			conn.Spec.Sync = &corev1alpha1.ConnectionSync{Mode: corev1alpha1.ConnectionSyncNone}
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())
			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})
	})

	Context("the live face", func() {
		It("defaults to GET only", func() {
			conn := confluenceConnection("api-defaults")
			conn.Spec.API = &corev1alpha1.ConnectionAPI{Enabled: true}
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())

			stored := &corev1alpha1.Connection{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{
				Name: conn.Name, Namespace: conn.Namespace,
			}, stored)).To(Succeed())
			Expect(stored.Spec.API.Methods).To(Equal([]corev1alpha1.ConnectionAPIMethod{
				corev1alpha1.ConnectionAPIMethodGet,
			}))

			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})

		It("rejects a write method, which has no authorization story yet", func() {
			conn := confluenceConnection("api-write")
			conn.Spec.API = &corev1alpha1.ConnectionAPI{
				Enabled: true,
				Methods: []corev1alpha1.ConnectionAPIMethod{"DELETE"},
			}
			Expect(k8sClient.Create(ctx, conn)).To(HaveOccurred())
		})
	})

	Context("When reconciling a resource", func() {
		It("reconciles a valid connection without error", func() {
			conn := confluenceConnection("reconcile-ok")
			Expect(k8sClient.Create(ctx, conn)).To(Succeed())

			name := types.NamespacedName{Name: conn.Name, Namespace: conn.Namespace}
			reconciler := &ConnectionReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: name})
			Expect(err).NotTo(HaveOccurred())

			Expect(k8sClient.Delete(ctx, conn)).To(Succeed())
		})
	})
})
