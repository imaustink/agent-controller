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
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

var _ = Describe("Skill Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default", // TODO(user):Modify as needed
		}
		skill := &toolv1alpha1.Skill{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind Skill")
			err := k8sClient.Get(ctx, typeNamespacedName, skill)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.Skill{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: toolv1alpha1.SkillSpec{
						Description: "test skill",
						Markdown:    "# Test Skill\n\nDo the thing.",
						ToolRefs:    []string{"nonexistent-tool"},
						AgentRefs:   []string{"nonexistent-agent"},
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			// TODO(user): Cleanup logic after each test, like removing the resource instance.
			resource := &toolv1alpha1.Skill{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance Skill")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
		})
		It("should successfully reconcile the resource", func() {
			By("Reconciling the created resource")
			controllerReconciler := &SkillReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			By("reporting a Degraded Ready condition since the referenced Tool and Agent do not exist")
			var updated toolv1alpha1.Skill
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("RefsMissing"))
			Expect(cond.Message).To(ContainSubstring("toolRefs not found"))
			Expect(cond.Message).To(ContainSubstring("agentRefs not found"))
		})
	})

	Context("When a Skill's agentRefs all resolve", func() {
		const resourceName = "agent-ref-skill"
		const agentName = "real-agent"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{Name: resourceName, Namespace: "default"}
		agentTypeNamespacedName := types.NamespacedName{Name: agentName, Namespace: "default"}

		BeforeEach(func() {
			By("creating the referenced Agent")
			agent := &toolv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: agentName, Namespace: "default"},
				Spec: toolv1alpha1.AgentSpec{
					Description:        "test agent",
					Input:              "a natural-language goal",
					Output:             "a final response payload",
					AllowedRoles:       []string{"writer"},
					Image:              "example.com/agent-loop:latest",
					ServiceAccountName: "agent-loop",
				},
			}
			Expect(k8sClient.Create(ctx, agent)).To(Succeed())

			By("creating a Skill whose agentRefs names that Agent")
			resource := &toolv1alpha1.Skill{
				ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: "default"},
				Spec: toolv1alpha1.SkillSpec{
					Description: "test skill",
					Markdown:    "# Test Skill\n\nDelegate to the agent.",
					AgentRefs:   []string{agentName},
				},
			}
			Expect(k8sClient.Create(ctx, resource)).To(Succeed())
		})

		AfterEach(func() {
			skillResource := &toolv1alpha1.Skill{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, skillResource)).To(Succeed())
			Expect(k8sClient.Delete(ctx, skillResource)).To(Succeed())

			agentResource := &toolv1alpha1.Agent{}
			Expect(k8sClient.Get(ctx, agentTypeNamespacedName, agentResource)).To(Succeed())
			Expect(k8sClient.Delete(ctx, agentResource)).To(Succeed())
		})

		It("should report Ready", func() {
			controllerReconciler := &SkillReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.Skill
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal("RefsResolved"))
		})
	})
})
