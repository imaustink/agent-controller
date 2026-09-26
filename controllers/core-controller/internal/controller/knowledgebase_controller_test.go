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
	"time"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

func globexKnowledgeBase(name string) *corev1alpha1.KnowledgeBase {
	return &corev1alpha1.KnowledgeBase{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
		Spec: corev1alpha1.KnowledgeBaseSpec{
			DisplayName: "GLOBEX",
			Description: "The GLOBEX client engagement: platform migration work, " +
				"their Confluence space and the #globex-eng Slack channel.",
			Aliases:    []string{"Southern National", "Project Harbor"},
			CorpusRefs: []string{"globex-confluence", "globex-slack-eng"},
		},
	}
}

var _ = Describe("KnowledgeBase Controller", func() {
	ctx := context.Background()

	Context("composition", func() {
		It("accepts several connections, including repeats of one provider", func() {
			kb := globexKnowledgeBase("kb-compose-ok")
			kb.Spec.CorpusRefs = []string{
				"globex-confluence", "globex-slack-eng", "globex-slack-general", "globex-drive",
				"platform-announcements", // shared with other knowledge bases
			}
			Expect(k8sClient.Create(ctx, kb)).To(Succeed())
			Expect(k8sClient.Delete(ctx, kb)).To(Succeed())
		})

		It("rejects a duplicated connection ref", func() {
			kb := globexKnowledgeBase("kb-dup-refs")
			kb.Spec.CorpusRefs = []string{"globex-confluence", "globex-confluence"}
			Expect(k8sClient.Create(ctx, kb)).To(HaveOccurred(),
				"a repeated ref would double-count one connection's chunks at merge")
		})

		It("rejects a knowledge base composing nothing", func() {
			kb := globexKnowledgeBase("kb-no-refs")
			kb.Spec.CorpusRefs = nil
			Expect(k8sClient.Create(ctx, kb)).To(HaveOccurred())
		})

		It("requires a description, since that is what retrieval discriminates on", func() {
			kb := globexKnowledgeBase("kb-no-description")
			kb.Spec.Description = ""
			Expect(k8sClient.Create(ctx, kb)).To(HaveOccurred())
		})
	})

	Context("defaults", func() {
		It("discloses partial visibility unless told otherwise", func() {
			kb := globexKnowledgeBase("kb-disclosure-default")
			Expect(k8sClient.Create(ctx, kb)).To(Succeed())

			stored := &corev1alpha1.KnowledgeBase{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{
				Name: kb.Name, Namespace: kb.Namespace,
			}, stored)).To(Succeed())

			Expect(stored.Spec.DisclosePartialVisibility).NotTo(BeNil())
			Expect(*stored.Spec.DisclosePartialVisibility).To(BeTrue(),
				"silence is the worse default: a confidently wrong 'there's nothing "+
					"about that' is the failure a knowledge base exists to prevent")

			Expect(k8sClient.Delete(ctx, kb)).To(Succeed())
		})

		It("applies chunking defaults", func() {
			kb := globexKnowledgeBase("kb-chunk-default")
			kb.Spec.Chunk = &corev1alpha1.KnowledgeBaseChunking{}
			Expect(k8sClient.Create(ctx, kb)).To(Succeed())

			stored := &corev1alpha1.KnowledgeBase{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{
				Name: kb.Name, Namespace: kb.Namespace,
			}, stored)).To(Succeed())
			Expect(stored.Spec.Chunk.MaxTokens).To(BeNumerically("==", 800))
			Expect(stored.Spec.Chunk.Overlap).To(BeNumerically("==", 100))

			Expect(k8sClient.Delete(ctx, kb)).To(Succeed())
		})

		It("rejects an overlap that is not smaller than the chunk", func() {
			kb := globexKnowledgeBase("kb-chunk-bad")
			kb.Spec.Chunk = &corev1alpha1.KnowledgeBaseChunking{MaxTokens: 200, Overlap: 200}
			Expect(k8sClient.Create(ctx, kb)).To(
				MatchError(ContainSubstring("chunk.overlap must be smaller than chunk.maxTokens")))
		})
	})

	Context("When reconciling a resource", func() {
		var reconciler *KnowledgeBaseReconciler

		BeforeEach(func() {
			reconciler = &KnowledgeBaseReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		})

		// createMember makes a synced Corpus and publishes the status a sync
		// worker would have written, so the knowledge base has something real
		// to aggregate.
		createMember := func(name string, resources int64, lastReconcile *metav1.Time) *corev1alpha1.Corpus {
			corpus := corpusFor("kb-member-connection", name)
			corpus.Spec.Sync = &corev1alpha1.CorpusSync{
				Mode:              corev1alpha1.CorpusSyncPoll,
				ReconcileInterval: &metav1.Duration{Duration: time.Hour},
			}
			Expect(k8sClient.Create(ctx, corpus)).To(Succeed())

			corpus.Status.Resources = resources
			corpus.Status.LastReconcileTime = lastReconcile
			corpus.Status.LastSyncTime = lastReconcile
			Expect(k8sClient.Status().Update(ctx, corpus)).To(Succeed())
			return corpus
		}

		reconcileKB := func(kb *corev1alpha1.KnowledgeBase) *corev1alpha1.KnowledgeBase {
			name := types.NamespacedName{Name: kb.Name, Namespace: kb.Namespace}
			_, err := reconciler.Reconcile(ctx, reconcile.Request{NamespacedName: name})
			Expect(err).NotTo(HaveOccurred())

			stored := &corev1alpha1.KnowledgeBase{}
			Expect(k8sClient.Get(ctx, name, stored)).To(Succeed())
			return stored
		}

		It("aggregates documents across its members", func() {
			fresh := metav1.Now()
			a := createMember("agg-member-a", 4120, &fresh)
			b := createMember("agg-member-b", 1192, &fresh)

			kb := globexKnowledgeBase("kb-aggregates")
			kb.Spec.CorpusRefs = []string{a.Name, b.Name}
			Expect(k8sClient.Create(ctx, kb)).To(Succeed())

			stored := reconcileKB(kb)
			Expect(stored.Status.Documents).To(BeNumerically("==", 5312))
			Expect(stored.Status.PerCorpus).To(HaveLen(2))
			Expect(stored.Status.MissingCorpora).To(BeEmpty())
			Expect(stored.Status.StaleCorpora).To(BeEmpty())
			Expect(meta.IsStatusConditionTrue(stored.Status.Conditions, "Ready")).To(BeTrue())

			Expect(k8sClient.Delete(ctx, kb)).To(Succeed())
			Expect(k8sClient.Delete(ctx, a)).To(Succeed())
			Expect(k8sClient.Delete(ctx, b)).To(Succeed())
		})

		It("reports a dangling ref rather than quietly answering from less", func() {
			fresh := metav1.Now()
			present := createMember("dangling-present", 10, &fresh)

			kb := globexKnowledgeBase("kb-dangling")
			kb.Spec.CorpusRefs = []string{present.Name, "never-created"}
			Expect(k8sClient.Create(ctx, kb)).To(Succeed())

			stored := reconcileKB(kb)
			Expect(stored.Status.MissingCorpora).To(ConsistOf("never-created"))
			Expect(stored.Status.PerCorpus).To(HaveLen(1),
				"the resolvable member still contributes")
			Expect(meta.IsStatusConditionTrue(stored.Status.Conditions, "Ready")).To(BeFalse())

			Expect(k8sClient.Delete(ctx, kb)).To(Succeed())
			Expect(k8sClient.Delete(ctx, present)).To(Succeed())
		})

		It("flags a member that has never reconciled as stale", func() {
			never := createMember("stale-never-reconciled", 0, nil)

			kb := globexKnowledgeBase("kb-stale")
			kb.Spec.CorpusRefs = []string{never.Name}
			Expect(k8sClient.Create(ctx, kb)).To(Succeed())

			stored := reconcileKB(kb)
			Expect(stored.Status.StaleCorpora).To(ConsistOf(never.Name))
			Expect(meta.IsStatusConditionTrue(stored.Status.Conditions, "Ready")).To(BeTrue(),
				"stale is a freshness signal, not a broken reference")

			Expect(k8sClient.Delete(ctx, kb)).To(Succeed())
			Expect(k8sClient.Delete(ctx, never)).To(Succeed())
		})
	})

	Context("watch fan-out", func() {
		It("enqueues every knowledge base composing a changed connection", func() {
			shared := confluenceConnection("shared-announcements")
			Expect(k8sClient.Create(ctx, shared)).To(Succeed())

			first := globexKnowledgeBase("kb-fanout-one")
			first.Spec.CorpusRefs = []string{shared.Name}
			Expect(k8sClient.Create(ctx, first)).To(Succeed())

			second := globexKnowledgeBase("kb-fanout-two")
			second.Spec.CorpusRefs = []string{shared.Name, "globex-confluence"}
			Expect(k8sClient.Create(ctx, second)).To(Succeed())

			unrelated := globexKnowledgeBase("kb-fanout-unrelated")
			unrelated.Spec.CorpusRefs = []string{"some-other-connection"}
			Expect(k8sClient.Create(ctx, unrelated)).To(Succeed())

			reconciler := &KnowledgeBaseReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			requests := reconciler.knowledgeBasesForCorpus(ctx, shared)

			names := make([]string, 0, len(requests))
			for _, req := range requests {
				names = append(names, req.Name)
			}
			Expect(names).To(ConsistOf("kb-fanout-one", "kb-fanout-two"),
				"one shared connection is context for several clients, and none of the others")

			Expect(k8sClient.Delete(ctx, first)).To(Succeed())
			Expect(k8sClient.Delete(ctx, second)).To(Succeed())
			Expect(k8sClient.Delete(ctx, unrelated)).To(Succeed())
			Expect(k8sClient.Delete(ctx, shared)).To(Succeed())
		})
	})
})
