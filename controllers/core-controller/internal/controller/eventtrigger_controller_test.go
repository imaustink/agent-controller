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
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

// statusWriteCounter counts status writes. The API server does not bump
// resourceVersion for a byte-identical update, so only counting the calls
// shows whether a reconcile skipped one.
type statusWriteCounter struct {
	client.Client
	writes *int
}

func (c statusWriteCounter) Status() client.SubResourceWriter {
	return countingStatusWriter{SubResourceWriter: c.Client.Status(), writes: c.writes}
}

type countingStatusWriter struct {
	client.SubResourceWriter
	writes *int
}

func (w countingStatusWriter) Update(ctx context.Context, obj client.Object, opts ...client.SubResourceUpdateOption) error {
	*w.writes++
	return w.SubResourceWriter.Update(ctx, obj, opts...)
}

func (w countingStatusWriter) Patch(ctx context.Context, obj client.Object, patch client.Patch, opts ...client.SubResourcePatchOption) error {
	*w.writes++
	return w.SubResourceWriter.Patch(ctx, obj, patch, opts...)
}

var _ = Describe("EventTrigger Controller", func() {
	ctx := context.Background()

	// One of each referable kind, shared by every case below.
	const (
		sourceName = "trigger-test-source"
		skillName  = "trigger-test-skill"
		agentName  = "trigger-test-agent"
		toolName   = "trigger-test-tool"
	)

	BeforeEach(func() {
		Expect(k8sClient.Create(ctx, cronSource(sourceName, "0 7 * * *"))).To(Succeed())
		Expect(k8sClient.Create(ctx, &corev1alpha1.Skill{
			ObjectMeta: metav1.ObjectMeta{Name: skillName, Namespace: "default"},
			Spec:       corev1alpha1.SkillSpec{Description: "test skill", Markdown: "# Test"},
		})).To(Succeed())
		Expect(k8sClient.Create(ctx, &corev1alpha1.Agent{
			ObjectMeta: metav1.ObjectMeta{Name: agentName, Namespace: "default"},
			Spec: corev1alpha1.AgentSpec{
				Description:  "test agent",
				Input:        "a goal",
				Output:       "a result",
				AllowedRoles: []string{"reader"},
				Image:        "example.com/agent:latest",
			},
		})).To(Succeed())
		Expect(k8sClient.Create(ctx, &corev1alpha1.Tool{
			ObjectMeta: metav1.ObjectMeta{Name: toolName, Namespace: "default"},
			Spec: corev1alpha1.ToolSpec{
				Description:        "test tool",
				Input:              "params",
				Output:             "a result",
				AllowedRoles:       []string{"reader"},
				Image:              "example.com/tool:latest",
				ServiceAccountName: "tool",
			},
		})).To(Succeed())
	})

	AfterEach(func() {
		key := func(name string) types.NamespacedName {
			return types.NamespacedName{Name: name, Namespace: "default"}
		}
		var source corev1alpha1.EventSource
		if k8sClient.Get(ctx, key(sourceName), &source) == nil {
			Expect(k8sClient.Delete(ctx, &source)).To(Succeed())
		}
		var skill corev1alpha1.Skill
		Expect(k8sClient.Get(ctx, key(skillName), &skill)).To(Succeed())
		Expect(k8sClient.Delete(ctx, &skill)).To(Succeed())
		var agent corev1alpha1.Agent
		Expect(k8sClient.Get(ctx, key(agentName), &agent)).To(Succeed())
		Expect(k8sClient.Delete(ctx, &agent)).To(Succeed())
		var tool corev1alpha1.Tool
		Expect(k8sClient.Get(ctx, key(toolName), &tool)).To(Succeed())
		Expect(k8sClient.Delete(ctx, &tool)).To(Succeed())
	})

	// readyAfterReconcile creates the trigger, reconciles it once, and returns
	// its Ready condition.
	readyAfterReconcile := func(trigger *corev1alpha1.EventTrigger) *metav1.Condition {
		Expect(k8sClient.Create(ctx, trigger)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, trigger) })

		r := &EventTriggerReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		key := types.NamespacedName{Name: trigger.Name, Namespace: "default"}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())

		var got corev1alpha1.EventTrigger
		Expect(k8sClient.Get(ctx, key, &got)).To(Succeed())
		cond := meta.FindStatusCondition(got.Status.Conditions, eventTriggerConditionReady)
		Expect(cond).NotTo(BeNil())
		return cond
	}

	validTrigger := func(name string) *corev1alpha1.EventTrigger {
		return &corev1alpha1.EventTrigger{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
			Spec: corev1alpha1.EventTriggerSpec{
				SourceRef: sourceName,
				Match: corev1alpha1.EventTriggerMatch{
					CEL: `headers["x-github-event"] == "pull_request" && body.action == "labeled"`,
				},
				Params: map[string]string{
					"repo":   "body.repository.full_name",
					"number": "body.pull_request.number",
				},
				Target: corev1alpha1.EventTriggerTarget{
					AgentRef:       agentName,
					ReadOnly:       true,
					PromptTemplate: "Review {{repo}}#{{number}}",
				},
			},
		}
	}

	It("is Ready when its CEL compiles and every ref resolves", func() {
		cond := readyAfterReconcile(validTrigger("ready-agent"))
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
		Expect(cond.Reason).To(Equal("Resolved"))
	})

	It("does not write status when a reconcile changes nothing", func() {
		trigger := validTrigger("no-op-status")
		readyAfterReconcile(trigger)

		key := types.NamespacedName{Name: trigger.Name, Namespace: "default"}
		writes := 0
		r := &EventTriggerReconciler{Client: statusWriteCounter{Client: k8sClient, writes: &writes}, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())
		Expect(writes).To(BeZero())

		// A change that DOES move the verdict is still written.
		var got corev1alpha1.EventTrigger
		Expect(k8sClient.Get(ctx, key, &got)).To(Succeed())
		got.Spec.Target = corev1alpha1.EventTriggerTarget{AgentRef: "no-such-agent", PromptTemplate: "x"}
		Expect(k8sClient.Update(ctx, &got)).To(Succeed())
		_, err = r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())
		Expect(writes).To(Equal(1))
	})

	It("stamps the Ready condition with the generation it checked", func() {
		trigger := validTrigger("observed-generation")
		cond := readyAfterReconcile(trigger)
		key := types.NamespacedName{Name: trigger.Name, Namespace: "default"}

		var got corev1alpha1.EventTrigger
		Expect(k8sClient.Get(ctx, key, &got)).To(Succeed())
		Expect(cond.ObservedGeneration).To(Equal(got.Generation))

		// A spec edit bumps the generation; until the next reconcile the
		// condition is stale, which is what the engines check for.
		got.Spec.Target.PromptTemplate = "Edited {{repo}}"
		Expect(k8sClient.Update(ctx, &got)).To(Succeed())
		Expect(k8sClient.Get(ctx, key, &got)).To(Succeed())
		stale := meta.FindStatusCondition(got.Status.Conditions, eventTriggerConditionReady)
		Expect(stale.ObservedGeneration).To(BeNumerically("<", got.Generation))

		r := &EventTriggerReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: key})
		Expect(err).NotTo(HaveOccurred())
		Expect(k8sClient.Get(ctx, key, &got)).To(Succeed())
		fresh := meta.FindStatusCondition(got.Status.Conditions, eventTriggerConditionReady)
		Expect(fresh.ObservedGeneration).To(Equal(got.Generation))
	})

	It("resolves skill, tool and orchestrator targets too", func() {
		skill := validTrigger("ready-skill")
		skill.Spec.Target = corev1alpha1.EventTriggerTarget{SkillRef: skillName, PromptTemplate: "go"}
		Expect(readyAfterReconcile(skill).Status).To(Equal(metav1.ConditionTrue))

		// toolRef needs no promptTemplate.
		tool := validTrigger("ready-tool")
		tool.Spec.Target = corev1alpha1.EventTriggerTarget{ToolRef: toolName}
		Expect(readyAfterReconcile(tool).Status).To(Equal(metav1.ConditionTrue))

		orch := validTrigger("ready-orchestrator")
		orch.Spec.SourceRef = ""
		orch.Spec.Match.CEL = ""
		orch.Spec.Target = corev1alpha1.EventTriggerTarget{
			Orchestrator:   &corev1alpha1.OrchestratorTarget{},
			PromptTemplate: "go",
		}
		Expect(readyAfterReconcile(orch).Status).To(Equal(metav1.ConditionTrue))
	})

	It("is InvalidCEL when match.cel does not compile", func() {
		trigger := validTrigger("bad-match")
		trigger.Spec.Match.CEL = `body.action ==`
		cond := readyAfterReconcile(trigger)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("InvalidCEL"))
		Expect(cond.Message).To(ContainSubstring("match.cel"))
	})

	It("is InvalidCEL when match.cel cannot yield a bool", func() {
		trigger := validTrigger("non-bool-match")
		trigger.Spec.Match.CEL = `source`
		cond := readyAfterReconcile(trigger)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("InvalidCEL"))
	})

	It("is InvalidCEL when a param does not compile", func() {
		trigger := validTrigger("bad-param")
		trigger.Spec.Params["broken"] = `request.body`
		cond := readyAfterReconcile(trigger)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("InvalidCEL"))
		Expect(cond.Message).To(ContainSubstring("params.broken"))
	})

	It("is SourceNotFound when sourceRef names no EventSource", func() {
		trigger := validTrigger("dangling-source")
		trigger.Spec.SourceRef = "no-such-source"
		cond := readyAfterReconcile(trigger)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("SourceNotFound"))
	})

	It("is TargetNotFound when the target names no resource", func() {
		agent := validTrigger("dangling-agent")
		agent.Spec.Target.AgentRef = "no-such-agent"
		cond := readyAfterReconcile(agent)
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("TargetNotFound"))

		// An Agent's name is not a Tool: the ref is resolved against its own kind.
		tool := validTrigger("tool-named-like-agent")
		tool.Spec.Target = corev1alpha1.EventTriggerTarget{ToolRef: agentName}
		Expect(readyAfterReconcile(tool).Reason).To(Equal("TargetNotFound"))

		skill := validTrigger("dangling-skill")
		skill.Spec.Target = corev1alpha1.EventTriggerTarget{SkillRef: "no-such-skill", PromptTemplate: "go"}
		Expect(readyAfterReconcile(skill).Reason).To(Equal("TargetNotFound"))
	})

	It("maps a referenced resource back to the triggers naming it", func() {
		r := &EventTriggerReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		named := validTrigger("maps-named")
		other := validTrigger("maps-other")
		other.Spec.Target.AgentRef = "some-other-agent"
		Expect(k8sClient.Create(ctx, named)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, named) })
		Expect(k8sClient.Create(ctx, other)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, other) })

		agent := &corev1alpha1.Agent{ObjectMeta: metav1.ObjectMeta{Name: agentName, Namespace: "default"}}
		reqs := r.triggersReferencing(ctx, agent, func(t *corev1alpha1.EventTrigger) string { return t.Spec.Target.AgentRef })
		Expect(reqs).To(ConsistOf(reconcile.Request{
			NamespacedName: types.NamespacedName{Name: "maps-named", Namespace: "default"},
		}))
	})
})
