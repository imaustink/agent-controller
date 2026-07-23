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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

var _ = Describe("Agent Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default", // TODO(user):Modify as needed
		}
		agent := &toolv1alpha1.Agent{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind Agent")
			err := k8sClient.Get(ctx, typeNamespacedName, agent)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.Agent{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: toolv1alpha1.AgentSpec{
						Description:        "test agent",
						Input:              "a natural-language goal",
						Output:             "a final response payload",
						AllowedRoles:       []string{"reader"},
						Image:              "example.com/agent-loop:latest",
						ServiceAccountName: "missing-agent-sa",
						SkillRefs:          []string{"nonexistent-skill"},
						Model:              "gpt-4o",
						MaxIterations:      5,
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			// TODO(user): Cleanup logic after each test, like removing the resource instance.
			resource := &toolv1alpha1.Agent{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance Agent")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
		})
		It("should successfully reconcile the resource", func() {
			By("Reconciling the created resource")
			controllerReconciler := &AgentReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			By("reporting a Degraded Ready condition since the referenced ServiceAccount does not exist")
			var updated toolv1alpha1.Agent
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("ServiceAccountMissing"))
		})
	})

	Context("When an Agent declares toolRefs", func() {
		const resourceName = "test-agent-toolrefs"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}

		BeforeEach(func() {
			By("creating a ServiceAccount the Agent references")
			sa := &corev1.ServiceAccount{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "toolrefs-agent-sa",
					Namespace: "default",
				},
			}
			err := k8sClient.Get(ctx, types.NamespacedName{Name: sa.Name, Namespace: sa.Namespace}, &corev1.ServiceAccount{})
			if err != nil && errors.IsNotFound(err) {
				Expect(k8sClient.Create(ctx, sa)).To(Succeed())
			}

			By("creating the custom resource for the Kind Agent with a dangling toolRef")
			var agent toolv1alpha1.Agent
			err = k8sClient.Get(ctx, typeNamespacedName, &agent)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.Agent{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: toolv1alpha1.AgentSpec{
						Description:        "test agent with toolRefs",
						Input:              "a natural-language goal",
						Output:             "a final response payload",
						AllowedRoles:       []string{"reader"},
						Image:              "example.com/agent-loop:latest",
						ServiceAccountName: sa.Name,
						ToolRefs:           []string{"nonexistent-tool"},
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &toolv1alpha1.Agent{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, resource)).To(Succeed())
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())

			sa := &corev1.ServiceAccount{}
			if err := k8sClient.Get(ctx, types.NamespacedName{Name: "toolrefs-agent-sa", Namespace: "default"}, sa); err == nil {
				Expect(k8sClient.Delete(ctx, sa)).To(Succeed())
			}
		})

		It("should report ToolRefsMissing when a toolRef does not resolve to a Tool CR", func() {
			controllerReconciler := &AgentReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.Agent
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("ToolRefsMissing"))
		})

		It("should report Ready once the referenced Tool CR exists", func() {
			tool := &toolv1alpha1.Tool{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "nonexistent-tool",
					Namespace: "default",
				},
				Spec: toolv1alpha1.ToolSpec{
					Description:        "a tool the agent may call",
					Input:              "argv[2]/stdin contract",
					Output:             "result envelope",
					AllowedRoles:       []string{"reader"},
					Image:              "example.com/tool:latest",
					ServiceAccountName: "toolrefs-agent-sa",
				},
			}
			Expect(k8sClient.Create(ctx, tool)).To(Succeed())
			DeferCleanup(func() {
				Expect(k8sClient.Delete(ctx, tool)).To(Succeed())
			})

			controllerReconciler := &AgentReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.Agent
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal("Ready"))
		})
	})
})
