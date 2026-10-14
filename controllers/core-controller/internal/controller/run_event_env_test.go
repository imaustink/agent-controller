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
	batchv1 "k8s.io/api/batch/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

// The event-trigger fields of a run reach its container as env
// (docs/event-triggers.md §6), through the real reconcilers rather than the
// helpers alone, so a run controller that stops passing them fails here.
var _ = Describe("Run event env", func() {
	ctx := context.Background()

	callback := toolv1alpha1.ToolRunCallback{NatsSubject: "callbacks.event-env"}

	envOf := func(job *batchv1.Job) map[string]string {
		out := map[string]string{}
		for _, e := range job.Spec.Template.Spec.Containers[0].Env {
			out[e.Name] = e.Value
		}
		return out
	}

	// envtest runs no garbage collector, so the owned Job is removed by hand.
	jobFor := func(name string) *batchv1.Job {
		var job batchv1.Job
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: "default"}, &job)).To(Succeed())
		DeferCleanup(func() {
			_ = k8sClient.Delete(ctx, &job, client.PropagationPolicy(metav1.DeletePropagationBackground))
		})
		return &job
	}

	Context("an AgentRun", func() {
		const agentName = "event-env-agent"

		BeforeEach(func() {
			agent := &toolv1alpha1.Agent{
				ObjectMeta: metav1.ObjectMeta{Name: agentName, Namespace: "default"},
				Spec: toolv1alpha1.AgentSpec{
					Description:  "event env agent",
					Input:        "a goal",
					Output:       "a result",
					AllowedRoles: []string{"reader"},
					Image:        "example.com/agent:latest",
				},
			}
			Expect(k8sClient.Create(ctx, agent)).To(Succeed())
			DeferCleanup(func() { _ = k8sClient.Delete(ctx, agent) })
		})

		launch := func(name string, readOnly bool, params map[string]string) map[string]string {
			run := &toolv1alpha1.AgentRun{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
				Spec: toolv1alpha1.AgentRunSpec{
					AgentRef: agentName,
					Goal:     "review the pull request",
					Callback: callback,
					ReadOnly: readOnly,
					Params:   params,
				},
			}
			Expect(k8sClient.Create(ctx, run)).To(Succeed())
			DeferCleanup(func() { _ = k8sClient.Delete(ctx, run) })

			r := &AgentRunReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: "default"}})
			Expect(err).NotTo(HaveOccurred())
			// An AgentRun's Job is named after the run itself.
			return envOf(jobFor(name))
		}

		It("carries readOnly and params as AGENT_READ_ONLY and a compact AGENT_PARAMS object", func() {
			env := launch("agentrun-event-env", true, map[string]string{"repo": "o/r", "number": "7"})
			Expect(env).To(HaveKeyWithValue("AGENT_READ_ONLY", "true"))
			Expect(env).To(HaveKeyWithValue("AGENT_PARAMS", `{"number":"7","repo":"o/r"}`))
		})

		It("sets neither when the run has no readOnly or params", func() {
			env := launch("agentrun-no-event-env", false, nil)
			Expect(env).NotTo(HaveKey("AGENT_READ_ONLY"))
			Expect(env).NotTo(HaveKey("AGENT_PARAMS"))
			// The run still launched normally.
			Expect(env).To(HaveKeyWithValue("AGENT_GOAL", "review the pull request"))
		})
	})

	Context("a ToolRun", func() {
		const toolName = "event-env-tool"

		BeforeEach(func() {
			tool := &toolv1alpha1.Tool{
				ObjectMeta: metav1.ObjectMeta{Name: toolName, Namespace: "default"},
				Spec: toolv1alpha1.ToolSpec{
					Description:        "event env tool",
					Input:              "params",
					Output:             "a result",
					AllowedRoles:       []string{"reader"},
					Image:              "example.com/tool:latest",
					ServiceAccountName: "tool",
					Env:                []toolv1alpha1.EnvVar{{Name: "STATIC", Value: "kept"}},
				},
			}
			Expect(k8sClient.Create(ctx, tool)).To(Succeed())
			DeferCleanup(func() { _ = k8sClient.Delete(ctx, tool) })
		})

		launch := func(name string, readOnly bool) map[string]string {
			run := &toolv1alpha1.ToolRun{
				ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
				Spec: toolv1alpha1.ToolRunSpec{
					ToolRef:  toolName,
					Callback: callback,
					ReadOnly: readOnly,
				},
			}
			Expect(k8sClient.Create(ctx, run)).To(Succeed())
			DeferCleanup(func() { _ = k8sClient.Delete(ctx, run) })

			r := &ToolRunReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
			_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: "default"}})
			Expect(err).NotTo(HaveOccurred())
			return envOf(jobFor("toolrun-" + name))
		}

		It("carries readOnly as TOOL_READ_ONLY alongside the Tool's static env", func() {
			env := launch("event-env-ro", true)
			Expect(env).To(HaveKeyWithValue("TOOL_READ_ONLY", "true"))
			Expect(env).To(HaveKeyWithValue("STATIC", "kept"))
		})

		It("does not set TOOL_READ_ONLY when the run is not read-only", func() {
			env := launch("event-env-rw", false)
			Expect(env).NotTo(HaveKey("TOOL_READ_ONLY"))
			Expect(env).To(HaveKeyWithValue("STATIC", "kept"))
		})
	})
})
