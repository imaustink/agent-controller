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
	"testing"

	"k8s.io/utils/ptr"
)

// The three-state resolution from ADR 0043: unset inherits the cluster
// default, a name wins over it, and an explicit empty string opts out of it.
func TestResolveRuntimeClassName(t *testing.T) {
	cases := []struct {
		name    string
		spec    *string
		cluster string
		want    *string
	}{
		{
			name: "unset with no cluster default is the cluster's own runtime",
			want: nil,
		},
		{
			name:    "unset inherits the cluster default",
			cluster: "gvisor",
			want:    ptr.To("gvisor"),
		},
		{
			name: "a catalog entry's choice applies with no default set",
			spec: ptr.To("kata"),
			want: ptr.To("kata"),
		},
		{
			name:    "a catalog entry's choice wins over the default",
			spec:    ptr.To("kata"),
			cluster: "gvisor",
			want:    ptr.To("kata"),
		},
		{
			// The reason the field is a pointer: a tool whose tooling does not
			// survive a sandboxed runtime must be able to opt out of a
			// cluster-wide default, which "unset" cannot express.
			name:    "an explicit empty string opts out of the default",
			spec:    ptr.To(""),
			cluster: "gvisor",
			want:    nil,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AGENT_DEFAULT_RUNTIME_CLASS", tc.cluster)
			got := resolveRuntimeClassName(tc.spec)
			switch {
			case tc.want == nil && got != nil:
				t.Fatalf("runtimeClassName = %q, want nil", *got)
			case tc.want != nil && got == nil:
				t.Fatalf("runtimeClassName = nil, want %q", *tc.want)
			case tc.want != nil && *got != *tc.want:
				t.Fatalf("runtimeClassName = %q, want %q", *got, *tc.want)
			}
		})
	}
}

// Whatever the operator picks has to reach the pod on both execution
// backends, or sandboxing a Tool would silently depend on which backend
// happened to run it.
func TestRuntimeClassReachesBothBackends(t *testing.T) {
	p := paramsFixture()
	p.runtimeClassName = ptr.To("gvisor")

	job, err := buildRunJob(p)
	if err != nil {
		t.Fatalf("buildRunJob: %v", err)
	}
	sb, err := buildRunSandbox(p)
	if err != nil {
		t.Fatalf("buildRunSandbox: %v", err)
	}

	for _, tc := range []struct {
		backend string
		got     *string
	}{
		{"job", job.Spec.Template.Spec.RuntimeClassName},
		{"sandbox", sb.Spec.PodTemplate.Spec.RuntimeClassName},
	} {
		if tc.got == nil {
			t.Errorf("%s backend: runtimeClassName is nil, want gvisor", tc.backend)
			continue
		}
		if *tc.got != "gvisor" {
			t.Errorf("%s backend: runtimeClassName = %q, want gvisor", tc.backend, *tc.got)
		}
	}
}

// The default stays the cluster's own runtime, so adding this field changes
// nothing for a deployment that does not opt in.
func TestNoRuntimeClassByDefault(t *testing.T) {
	t.Setenv("AGENT_DEFAULT_RUNTIME_CLASS", "")

	job, err := buildRunJob(paramsFixture())
	if err != nil {
		t.Fatalf("buildRunJob: %v", err)
	}
	if rc := job.Spec.Template.Spec.RuntimeClassName; rc != nil {
		t.Errorf("runtimeClassName = %q, want nil for an unconfigured deployment", *rc)
	}
}
