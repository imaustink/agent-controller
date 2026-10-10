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

var _ = Describe("IdentityProvider Controller", func() {
	Context("When reconciling a resource with no siblings", func() {
		const resourceName = "test-provider"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{Name: resourceName, Namespace: "default"}
		provider := &toolv1alpha1.IdentityProvider{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind IdentityProvider")
			err := k8sClient.Get(ctx, typeNamespacedName, provider)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.IdentityProvider{
					ObjectMeta: metav1.ObjectMeta{Name: resourceName, Namespace: "default"},
					Spec: toolv1alpha1.IdentityProviderSpec{
						EnvVar: "TEST_PROVIDER_TOKEN",
						Label:  "Test Provider",
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &toolv1alpha1.IdentityProvider{}
			Expect(k8sClient.Get(ctx, typeNamespacedName, resource)).To(Succeed())
			By("Cleanup the specific resource instance IdentityProvider")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
		})

		It("should default flow to oauth and report Ready", func() {
			By("Reconciling the created resource")
			controllerReconciler := &IdentityProviderReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.IdentityProvider
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			Expect(updated.Spec.Flow).To(Equal(toolv1alpha1.IdentityProviderFlowOAuth))

			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionTrue))
			Expect(cond.Reason).To(Equal("Unique"))
		})
	})

	Context("When two IdentityProviders in the same namespace share an envVar and a label", func() {
		const firstName = "first-provider"
		const secondName = "second-provider"

		ctx := context.Background()

		firstNamespacedName := types.NamespacedName{Name: firstName, Namespace: "default"}
		secondNamespacedName := types.NamespacedName{Name: secondName, Namespace: "default"}

		BeforeEach(func() {
			By("creating two colliding IdentityProviders")
			first := &toolv1alpha1.IdentityProvider{
				ObjectMeta: metav1.ObjectMeta{Name: firstName, Namespace: "default"},
				Spec:       toolv1alpha1.IdentityProviderSpec{EnvVar: "SHARED_TOKEN", Label: "Shared"},
			}
			Expect(k8sClient.Create(ctx, first)).To(Succeed())

			second := &toolv1alpha1.IdentityProvider{
				ObjectMeta: metav1.ObjectMeta{Name: secondName, Namespace: "default"},
				Spec:       toolv1alpha1.IdentityProviderSpec{EnvVar: "SHARED_TOKEN", Label: "Shared"},
			}
			Expect(k8sClient.Create(ctx, second)).To(Succeed())
		})

		AfterEach(func() {
			first := &toolv1alpha1.IdentityProvider{}
			Expect(k8sClient.Get(ctx, firstNamespacedName, first)).To(Succeed())
			Expect(k8sClient.Delete(ctx, first)).To(Succeed())

			second := &toolv1alpha1.IdentityProvider{}
			Expect(k8sClient.Get(ctx, secondNamespacedName, second)).To(Succeed())
			Expect(k8sClient.Delete(ctx, second)).To(Succeed())
		})

		It("should report a Degraded Ready condition naming the collision", func() {
			controllerReconciler := &IdentityProviderReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: firstNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.IdentityProvider
			Expect(k8sClient.Get(ctx, firstNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("Collision"))
			Expect(cond.Message).To(ContainSubstring("envVar \"SHARED_TOKEN\""))
			Expect(cond.Message).To(ContainSubstring("label \"Shared\""))
		})
	})
})
