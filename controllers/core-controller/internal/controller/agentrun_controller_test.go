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

			By("creating an owned Job with the goal injected as AGENT_GOAL env and NATS env wired in")
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
			// The goal is delivered via AGENT_GOAL env, not container args.
			expectEnv := func(name, value string) {
				for _, e := range container.Env {
					if e.Name == name {
						Expect(e.Value).To(Equal(value), "env var %s", name)
						return
					}
				}
				Fail("env var not found: " + name)
			}
			expectEnv("AGENT_GOAL", "extract and refine the recipe at https://example.com/recipe")
			expectEnv("AGENT_RUN_ID", resourceName)
			expectEnv("AGENT_NATS_URL", "nats://nats:4222") // default when controller env unset
			expectEnv("AGENT_NATS_SUBJECT_PREFIX", "agent") // default when controller env unset
			Expect(*container.SecurityContext.ReadOnlyRootFilesystem).To(BeTrue())
			Expect(*container.SecurityContext.AllowPrivilegeEscalation).To(BeFalse())
		})

		It("merges AgentRun.Spec.SecretEnv over the Agent template's static secretEnv by name (docs/adr/0022)", func() {
			By("creating an Agent with a static secretEnv entry")
			identityAgentName := fmt.Sprintf("%s-identity-agent", resourceName)
			identityAgent := &toolv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: identityAgentName, Namespace: "default"},
				Spec: toolv1alpha1.AgentSpec{
					Description:        "identity-linked test agent",
					Input:              "a natural-language goal",
					Output:             "a final response payload",
					AllowedRoles:       []string{"reader"},
					Image:              "example.com/agent-loop:latest",
					ServiceAccountName: "agent-loop",
					IdentityProviders:  []string{"github"},
					SecretEnv: []toolv1alpha1.SecretEnvVar{
						{
							Name: "GITHUB_TOKEN",
							SecretRef: toolv1alpha1.SecretKeySelector{
								Name: "opencode-swe-secrets",
								Key:  "GITHUB_TOKEN",
							},
						},
						{
							Name: "ANTHROPIC_API_KEY",
							SecretRef: toolv1alpha1.SecretKeySelector{
								Name: "opencode-swe-secrets",
								Key:  "ANTHROPIC_API_KEY",
							},
						},
					},
				},
			}
			Expect(k8sClient.Create(ctx, identityAgent)).To(Succeed())
			defer func() {
				Expect(k8sClient.Delete(ctx, identityAgent)).To(Succeed())
			}()

			By("creating an AgentRun with a per-run SecretEnv override for the same GITHUB_TOKEN key")
			identityRunName := fmt.Sprintf("%s-identity-run", resourceName)
			identityRunKey := types.NamespacedName{Name: identityRunName, Namespace: "default"}
			identityRun := &toolv1alpha1.AgentRun{
				ObjectMeta: metav1.ObjectMeta{Name: identityRunName, Namespace: "default"},
				Spec: toolv1alpha1.AgentRunSpec{
					AgentRef: identityAgentName,
					Goal:     "open a PR as the linked user",
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

			By("reconciling the AgentRun")
			controllerReconciler := &AgentRunReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}
			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{NamespacedName: identityRunKey})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.AgentRun
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

			By("the AgentRun-level GITHUB_TOKEN entry winning over the Agent's static one")
			githubTokenEnv := findEnv("GITHUB_TOKEN")
			Expect(githubTokenEnv).NotTo(BeNil())
			Expect(githubTokenEnv.ValueFrom).NotTo(BeNil())
			Expect(githubTokenEnv.ValueFrom.SecretKeyRef).NotTo(BeNil())
			Expect(githubTokenEnv.ValueFrom.SecretKeyRef.Name).To(Equal(identityRunName + "-identity"))
			Expect(githubTokenEnv.ValueFrom.SecretKeyRef.Key).To(Equal("GITHUB_TOKEN"))

			By("the Agent's static ANTHROPIC_API_KEY entry passing through unchanged")
			anthropicEnv := findEnv("ANTHROPIC_API_KEY")
			Expect(anthropicEnv).NotTo(BeNil())
			Expect(anthropicEnv.ValueFrom).NotTo(BeNil())
			Expect(anthropicEnv.ValueFrom.SecretKeyRef).NotTo(BeNil())
			Expect(anthropicEnv.ValueFrom.SecretKeyRef.Name).To(Equal("opencode-swe-secrets"))
			Expect(anthropicEnv.ValueFrom.SecretKeyRef.Key).To(Equal("ANTHROPIC_API_KEY"))
		})
	})
})
