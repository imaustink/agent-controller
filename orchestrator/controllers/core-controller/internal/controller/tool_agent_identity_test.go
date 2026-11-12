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
	"strings"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	toolv1alpha1 "github.com/aktisai/orchestrator/controllers/core-controller/api/v1alpha1"
)

// docs/adr/0049 step 5: a Tool whose defaultIdentity is agent is Ready only
// when every resource provider it declares has an agentCredential.
var _ = Describe("Tool agent identity", func() {
	ctx := context.Background()

	BeforeEach(func() {
		sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: "agent-identity-tool", Namespace: "default"}}
		Expect(k8sClient.Create(ctx, sa)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, sa) })
	})

	provider := func(name string, flow toolv1alpha1.IdentityProviderFlow, withCredential bool) {
		idp := &toolv1alpha1.IdentityProvider{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
			Spec:       toolv1alpha1.IdentityProviderSpec{EnvVar: "TAI_" + strings.ToUpper(strings.ReplaceAll(name, "-", "_")), Label: "tai " + name, Flow: flow},
		}
		if withCredential {
			idp.Spec.AgentCredential = &toolv1alpha1.IdentityProviderAgentCredential{
				SecretRef: toolv1alpha1.SecretKeySelector{Name: "s", Key: "k"},
			}
		}
		Expect(k8sClient.Create(ctx, idp)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, idp) })
	}

	readyOf := func(name string, identity toolv1alpha1.ToolIdentityMode, providers ...string) *metav1.Condition {
		tool := &toolv1alpha1.Tool{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "default"},
			Spec: toolv1alpha1.ToolSpec{
				Description: "t", Input: "i", Output: "o", AllowedRoles: []string{"reader"},
				Image: "example.com/t:latest", ServiceAccountName: "agent-identity-tool",
				IdentityProviders: providers, DefaultIdentity: identity,
			},
		}
		Expect(k8sClient.Create(ctx, tool)).To(Succeed())
		DeferCleanup(func() { _ = k8sClient.Delete(ctx, tool) })
		r := &ToolReconciler{Client: k8sClient, Scheme: k8sClient.Scheme()}
		_, err := r.Reconcile(ctx, reconcile.Request{NamespacedName: types.NamespacedName{Name: name, Namespace: "default"}})
		Expect(err).NotTo(HaveOccurred())
		var updated toolv1alpha1.Tool
		Expect(k8sClient.Get(ctx, types.NamespacedName{Name: name, Namespace: "default"}, &updated)).To(Succeed())
		return meta.FindStatusCondition(updated.Status.Conditions, "Ready")
	}

	It("is Ready when every resource provider has an agentCredential, ignoring runtime providers", func() {
		provider("tai-jira", "", true)
		provider("tai-claude", toolv1alpha1.IdentityProviderFlowClaudeCLISetupToken, false)
		cond := readyOf("tai-ok", toolv1alpha1.ToolIdentityModeAgent, "tai-jira", "tai-claude")
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
	})

	It("is not Ready when a resource provider has no agentCredential", func() {
		provider("tai-slack", "", false)
		cond := readyOf("tai-nocred", toolv1alpha1.ToolIdentityModeAgent, "tai-slack")
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("AgentCredentialMissing"))
	})

	It("is not Ready when a declared provider does not exist", func() {
		cond := readyOf("tai-noidp", toolv1alpha1.ToolIdentityModeAgent, "tai-nowhere")
		Expect(cond.Status).To(Equal(metav1.ConditionFalse))
		Expect(cond.Reason).To(Equal("IdentityProviderMissing"))
	})

	It("does not check agentCredential for a delegated Tool", func() {
		provider("tai-gh", "", false)
		cond := readyOf("tai-delegated", toolv1alpha1.ToolIdentityModeDelegated, "tai-gh")
		Expect(cond.Status).To(Equal(metav1.ConditionTrue))
	})

	It("refuses defaultIdentity on an agent-backed Tool", func() {
		tool := &toolv1alpha1.Tool{
			ObjectMeta: metav1.ObjectMeta{Name: "tai-agentref", Namespace: "default"},
			Spec: toolv1alpha1.ToolSpec{
				Description: "t", Input: "i", Output: "o", AllowedRoles: []string{"reader"},
				AgentRef: "some-agent", DefaultIdentity: toolv1alpha1.ToolIdentityModeAgent,
			},
		}
		err := k8sClient.Create(ctx, tool)
		Expect(err).To(HaveOccurred())
		Expect(err.Error()).To(ContainSubstring("defaultIdentity is set on the wrapped Agent"))
	})
})
