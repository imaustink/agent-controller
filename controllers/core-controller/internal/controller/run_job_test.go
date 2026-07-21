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

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

// TestMergeSecretEnv is a plain (non-envtest) unit test of the pure
// AgentRun-over-Agent secretEnv merge helper — no cluster needed.
func TestMergeSecretEnv(t *testing.T) {
	secretRef := func(name, key string) toolv1alpha1.SecretKeySelector {
		return toolv1alpha1.SecretKeySelector{Name: name, Key: key}
	}

	t.Run("only agent-level secretEnv passes through unchanged", func(t *testing.T) {
		base := []toolv1alpha1.SecretEnvVar{
			{Name: "OPENAI_API_KEY", SecretRef: secretRef("agent-secrets", "openai")},
			{Name: "GITHUB_TOKEN", SecretRef: secretRef("agent-secrets", "github")},
		}

		got := mergeSecretEnv(base, nil)

		if len(got) != len(base) {
			t.Fatalf("expected %d entries, got %d: %+v", len(base), len(got), got)
		}
		for i, want := range base {
			if got[i] != want {
				t.Errorf("entry %d: got %+v, want %+v", i, got[i], want)
			}
		}
	})

	t.Run("agentrun-level entry with matching name wins", func(t *testing.T) {
		base := []toolv1alpha1.SecretEnvVar{
			{Name: "GITHUB_TOKEN", SecretRef: secretRef("agent-secrets", "github")},
		}
		overrides := []toolv1alpha1.SecretEnvVar{
			{Name: "GITHUB_TOKEN", SecretRef: secretRef("user-tokens", "alice-github")},
		}

		got := mergeSecretEnv(base, overrides)

		if len(got) != 1 {
			t.Fatalf("expected 1 entry, got %d: %+v", len(got), got)
		}
		if got[0] != overrides[0] {
			t.Errorf("got %+v, want override %+v to win", got[0], overrides[0])
		}
	})

	t.Run("entries unique to each side are both present", func(t *testing.T) {
		base := []toolv1alpha1.SecretEnvVar{
			{Name: "OPENAI_API_KEY", SecretRef: secretRef("agent-secrets", "openai")},
			{Name: "GITHUB_TOKEN", SecretRef: secretRef("agent-secrets", "github")},
		}
		overrides := []toolv1alpha1.SecretEnvVar{
			{Name: "GITHUB_TOKEN", SecretRef: secretRef("user-tokens", "alice-github")},
			{Name: "NPM_TOKEN", SecretRef: secretRef("user-tokens", "alice-npm")},
		}

		got := mergeSecretEnv(base, overrides)

		byName := make(map[string]toolv1alpha1.SecretEnvVar, len(got))
		for _, e := range got {
			byName[e.Name] = e
		}

		if len(got) != 3 {
			t.Fatalf("expected 3 entries, got %d: %+v", len(got), got)
		}
		if byName["OPENAI_API_KEY"] != base[0] {
			t.Errorf("expected base-only entry OPENAI_API_KEY unchanged, got %+v", byName["OPENAI_API_KEY"])
		}
		if byName["GITHUB_TOKEN"] != overrides[0] {
			t.Errorf("expected override to win for GITHUB_TOKEN, got %+v", byName["GITHUB_TOKEN"])
		}
		if byName["NPM_TOKEN"] != overrides[1] {
			t.Errorf("expected override-only entry NPM_TOKEN present, got %+v", byName["NPM_TOKEN"])
		}
	})
}
