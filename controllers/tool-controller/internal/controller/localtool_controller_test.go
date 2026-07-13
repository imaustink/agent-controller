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
	"testing"

	. "github.com/onsi/ginkgo/v2"
	. "github.com/onsi/gomega"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	toolv1alpha1 "github.com/recipe-agent/tool-controller/api/v1alpha1"
)

// TestValidateLocalToolSpec is a plain (non-envtest) unit test of the pure
// cross-field validator — no cluster needed.
func TestValidateLocalToolSpec(t *testing.T) {
	cases := []struct {
		name   string
		spec   toolv1alpha1.LocalToolSpec
		wantOK bool
	}{
		{
			name: "valid node with pinned version",
			spec: toolv1alpha1.LocalToolSpec{
				Runtime: "node", Package: "@scope/tool", Version: "1.2.3",
			},
			wantOK: true,
		},
		{
			name: "node missing version",
			spec: toolv1alpha1.LocalToolSpec{Runtime: "node", Package: "tool"},
		},
		{
			name: "node unpinned caret range",
			spec: toolv1alpha1.LocalToolSpec{Runtime: "node", Package: "tool", Version: "^1.2.0"},
		},
		{
			name: "node latest tag",
			spec: toolv1alpha1.LocalToolSpec{Runtime: "node", Package: "tool", Version: "latest"},
		},
		{
			name: "go missing package",
			spec: toolv1alpha1.LocalToolSpec{Runtime: "go", Version: "v1.0.0"},
		},
		{
			name: "valid shell with https + sha256",
			spec: toolv1alpha1.LocalToolSpec{
				Runtime:   "shell",
				SourceURL: "https://example.com/tool.sh",
				Checksum:  "0000000000000000000000000000000000000000000000000000000000000000",
			},
			wantOK: true,
		},
		{
			name: "shell missing checksum",
			spec: toolv1alpha1.LocalToolSpec{Runtime: "shell", SourceURL: "https://example.com/tool.sh"},
		},
		{
			name: "shell non-https source",
			spec: toolv1alpha1.LocalToolSpec{
				Runtime:   "shell",
				SourceURL: "http://example.com/tool.sh",
				Checksum:  "0000000000000000000000000000000000000000000000000000000000000000",
			},
		},
		{
			name: "unknown runtime",
			spec: toolv1alpha1.LocalToolSpec{Runtime: "ruby"},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			problems := validateLocalToolSpec(tc.spec)
			gotOK := len(problems) == 0
			if gotOK != tc.wantOK {
				t.Fatalf("validateLocalToolSpec() ok=%v (problems=%v), want ok=%v", gotOK, problems, tc.wantOK)
			}
		})
	}
}

var _ = Describe("LocalTool Controller", func() {
	Context("When reconciling a resource", func() {
		const resourceName = "test-localtool"

		ctx := context.Background()

		typeNamespacedName := types.NamespacedName{
			Name:      resourceName,
			Namespace: "default",
		}
		localtool := &toolv1alpha1.LocalTool{}

		BeforeEach(func() {
			By("creating the custom resource for the Kind LocalTool")
			err := k8sClient.Get(ctx, typeNamespacedName, localtool)
			if err != nil && errors.IsNotFound(err) {
				resource := &toolv1alpha1.LocalTool{
					ObjectMeta: metav1.ObjectMeta{
						Name:      resourceName,
						Namespace: "default",
					},
					Spec: toolv1alpha1.LocalToolSpec{
						Description:  "test local tool",
						Input:        "a URL on stdin",
						Output:       "an envelope on stdout",
						AllowedRoles: []string{"reader"},
						Runtime:      "node",
						Package:      "example-tool",
						// Deliberately unpinned -> should be reported invalid.
						Version: "latest",
					},
				}
				Expect(k8sClient.Create(ctx, resource)).To(Succeed())
			}
		})

		AfterEach(func() {
			resource := &toolv1alpha1.LocalTool{}
			err := k8sClient.Get(ctx, typeNamespacedName, resource)
			Expect(err).NotTo(HaveOccurred())

			By("Cleanup the specific resource instance LocalTool")
			Expect(k8sClient.Delete(ctx, resource)).To(Succeed())
		})

		It("should report SpecInvalid for an unpinned version", func() {
			By("Reconciling the created resource")
			controllerReconciler := &LocalToolReconciler{
				Client: k8sClient,
				Scheme: k8sClient.Scheme(),
			}

			_, err := controllerReconciler.Reconcile(ctx, reconcile.Request{
				NamespacedName: typeNamespacedName,
			})
			Expect(err).NotTo(HaveOccurred())

			var updated toolv1alpha1.LocalTool
			Expect(k8sClient.Get(ctx, typeNamespacedName, &updated)).To(Succeed())
			cond := meta.FindStatusCondition(updated.Status.Conditions, "Ready")
			Expect(cond).NotTo(BeNil())
			Expect(cond.Status).To(Equal(metav1.ConditionFalse))
			Expect(cond.Reason).To(Equal("SpecInvalid"))
		})
	})
})
