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
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

var _ = Describe("ToolRun Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-resource"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default", // TODO(user):Modify as needed
		}
		toolrun := &toolv1alpha1.ToolRun{}
		toolName := fmt.Sprintf("%s-tool", resourceName)

		BeforeEach(func() {
			By("creating the referenced Tool")
			tool := &toolv1alpha1.Tool{
				ObjectMeta: metav1.ObjectMeta{Name: toolName, Namespace: "default"},
				Spec: toolv1alpha1.ToolSpec{
					Description:        "test tool",
					Input:              "a URL",
					Output:             "a recipe JSON envelope",
					AllowedRoles:       []string{"reader"},
					Image:              "example.com/recipe-scraper:latest",
					ServiceAccountName: "recipe-scraper",
				},
			}
			Expect(k8sClient.Create(ctx, tool)).To(Succeed())

			By("creating the custom resource for the Kind ToolRun")
			err := k8sClient.Get(ctx, typeNamespacedName, toolrun)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.ToolRun{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: toolv1alpha1.ToolRunSpec{
						ToolRef: toolName,
						Args:    []string{"https://example.com/recipe"},
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
			resource := &toolv1alpha1.ToolRun{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance ToolRun")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())

			By("Cleanup the referenced Tool")
			tool := &toolv1alpha1.Tool{}
			Expect(k8sClient.Get(ctx, types.NamespacedName{Name: toolName, Namespace: "default"}, tool)).To(Succeed())
			Expect(k8sClient.Delete(ctx, tool)).To(Succeed())
		})
		It("should successfully reconcile the resource", func() {
			By("Reconciling the created resource")
			controllerReconciler := &ToolRunReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			By("creating an owned Job with the hardened security contract")
			var updated toolv1alpha1.ToolRun
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			Expect(updated.Status.Phase).To(Equal(toolv1alpha1.ToolRunPhasePending))
			Expect(updated.Status.JobName).NotTo(BeEmpty())

			var job batchv1.Job
			jobKey := types.NamespacedName{Name: updated.Status.JobName, Namespace: "default"}
			Expect(k8sClient.Get(ctx, jobKey, &job)).To(Succeed())
			Expect(job.OwnerReferences).To(HaveLen(1))
			Expect(job.OwnerReferences[0].Name).To(Equal(resourceName))

			container := job.Spec.Template.Spec.Containers[0]
			Expect(*container.SecurityContext.ReadOnlyRootFilesystem).To(BeTrue())
			Expect(*container.SecurityContext.RunAsNonRoot).To(BeTrue())
			Expect(*container.SecurityContext.AllowPrivilegeEscalation).To(BeFalse())
			Expect(container.SecurityContext.Capabilities.Drop).To(ConsistOf(corev1.Capability("ALL")))

			By("re-reconciling to sync Job status onto the ToolRun")
			_, err = controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())
		})

		It("merges ToolRun.Spec.SecretEnv over the Tool template's static secretEnv by name (ADR 0027)", func() {
			By("creating a Tool with a static secretEnv entry and identityProviders declared")
			identityToolName := fmt.Sprintf("%s-identity-tool", resourceName)
			identityTool := &toolv1alpha1.Tool{
				ObjectMeta: metav1.ObjectMeta{Name: identityToolName, Namespace: "default"},
				Spec: toolv1alpha1.ToolSpec{
					Description:        "identity-linked test tool",
					Input:              "a gh CLI command line",
					Output:             "gh's own output",
					AllowedRoles:       []string{"writer"},
					Image:              "example.com/github:latest",
					ServiceAccountName: "github-tool",
					IdentityProviders:  []string{"github"},
					SecretEnv: []toolv1alpha1.SecretEnvVar{
						{
							Name: "GITHUB_TOKEN",
							SecretRef: toolv1alpha1.SecretKeySelector{
								Name: "github-tool-secrets",
								Key:  "GITHUB_TOKEN",
							},
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, identityTool)).To(Succeed())
			defer func() {
				Expect(k8sClient.Delete(ctx, identityTool)).To(Succeed())
			}()

			By("creating a ToolRun with a per-run SecretEnv override for the same GITHUB_TOKEN key")
			identityRunName := fmt.Sprintf("%s-identity-run", resourceName)
			identityRunKey := types.NamespacedName{Name: identityRunName, Namespace: "default"}
			identityRun := &toolv1alpha1.ToolRun{
				ObjectMeta: metav1.ObjectMeta{Name: identityRunName, Namespace: "default"},
				Spec: toolv1alpha1.ToolRunSpec{
					ToolRef: identityToolName,
					Args:    []string{"issue view 86 --repo imaustink/agent-controller"},
					Callback: toolv1alpha1.ToolRunCallback{
						URL: "http://agent-orchestrator-callback.default.svc.cluster.local:8080",
						SecretRef: toolv1alpha1.SecretKeySelector{
							Name: "agent-orchestrator-secrets",
							Key:  "AGENT_CALLBACK_SECRET",
						},
					},
					SecretEnv: []toolv1alpha1.SecretEnvVar{
						{
							Name: "GITHUB_TOKEN",
							SecretRef: toolv1alpha1.SecretKeySelector{
								Name: identityRunName + "-identity",
								Key:  "GITHUB_TOKEN",
							},
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, identityRun)).To(Succeed())
			defer func() {
				Expect(k8sClient.Delete(ctx, identityRun)).To(Succeed())
			}()

			By("reconciling the ToolRun")
			controllerReconciler := &ToolRunReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}
			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: identityRunKey})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.ToolRun
			Expect(k8sClient.Get(ctx, identityRunKey, &updated)).To(Succeed())
			Expect(updated.Status.JobName).NotTo(BeEmpty())

			var job batchv1.Job
			jobKey := types.NamespacedName{Name: updated.Status.JobName, Namespace: "default"}
			Expect(k8sClient.Get(ctx, jobKey, &job)).To(Succeed())

			container := job.Spec.Template.Spec.Containers[0]
			findEnv := func(name string) *corev1.EnvVar {
				for i := range container.Env {
					if container.Env[i].Name == name {
						return &container.Env[i]
					}
				}
				return nil
			}

			By("the ToolRun-level GITHUB_TOKEN entry winning over the Tool's static one")
			githubTokenEnv := findEnv("GITHUB_TOKEN")
			Expect(githubTokenEnv).NotTo(BeNil())
			Expect(githubTokenEnv.ValueFrom.SecretKeyRef.LocalObjectReference.Name).To(Equal(identityRunName + "-identity"))
		})
	})
})
