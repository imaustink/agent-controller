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

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	batchv1 "k8s.io/api/batch/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	toolv1alpha1 "github.com/controller-agent/tool-controller/api/v1alpha1"
)

var _ = Describe("AgentRun Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default", // TODO(user):Modify as needed
		}
		agentrun := &toolv1alpha1.AgentRun{}
		agentName := fmt.Sprintf("%s-agent", resourceName)

		BeforeEach(func() {
			By("creating the referenced Agent")
			agent := &toolv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: agentName, Namespace: "default"},
				Spec: toolv1alpha1.AgentSpec{
					Description:        "test agent",
					Input:              "a natural-language goal",
					Output:             "a final response payload",
					AllowedRoles:       []string{"reader"},
					Image:              "example.com/agent-loop:latest",
					ServiceAccountName: "agent-loop",
				},
			}
			Expect(k8sClient.Create(ctx, agent)).To(Succeed())

			By("creating the custom resource for the Kind AgentRun")
			err := k8sClient.Get(ctx, typeNamespacedName, agentrun)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.AgentRun{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: toolv1alpha1.AgentRunSpec{
						AgentRef: agentName,
						Goal:     "extract and refine the recipe at https://example.com/recipe",
						Callback: toolv1alpha1.ToolRunCallback{
							URL: "http://agent-orchestrator-callback.default.svc.cluster.local:8080",
							SecretRef: toolv1alpha1.SecretKeySelector{
								Name: "agent-orchestrator-secrets",
								Key:  "AGENT_CALLBACK_SECRET",
							},
						},
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			// TODO(user): Cleanup logic after each test, like removing the resource instance.
			resource := &toolv1alpha1.AgentRun{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance AgentRun")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())

			By("Cleanup the referenced Agent")
			agent := &toolv1alpha1.Agent{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: agentName, Namespace: "default"}, agent)).To(Succeed())
			Expect(k8sClient.Delete(ctx, agent)).To(Succeed())
		})
		It("should successfully reconcile the resource", func() {
			By("Reconciling the created resource")
			controllerReconciler := &AgentRunReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			By("creating an owned Job with the goal as the container argument")
			var updated toolv1alpha1.AgentRun
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			Expect(updated.Status.Phase).To(Equal(toolv1alpha1.ToolRunPhasePending))
			Expect(updated.Status.JobName).NotTo(BeEmpty())

			var job batchv1.Job
			jobKey := types.NamespacedName{Name: updated.Status.JobName, Namespace: "default"}
			Expect(k8sClient.Get(ctx, jobKey, &job)).To(Succeed())
			Expect(job.OwnerReferences).To(HaveLen(1))
			Expect(job.OwnerReferences[0].Name).To(Equal(resourceName))

			container := job.Spec.Template.Spec.Containers[0]
			Expect(container.Args).To(Equal([]string{"extract and refine the recipe at https://example.com/recipe"}))
			Expect(*container.SecurityContext.ReadOnlyRootFilesystem).To(BeTrue())
			Expect(*container.SecurityContext.AllowPrivilegeEscalation).To(BeFalse())
		})
	})
})
