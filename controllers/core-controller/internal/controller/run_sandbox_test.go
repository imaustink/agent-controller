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
	"time"

	"github.com/google/go-cmp/cmp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
	"github.com/controller-agent/core-controller/internal/sandboxapi"
)

// paramsFixture is a run exercising every field that feeds the pod spec:
// static env, a secretEnv credential (ADR 0032's per-user token shape), an
// init container, resources, a service account, and HTTP callback delivery.
func paramsFixture() runJobParams {
	return runJobParams{
		jobName:   "toolrun-demo",
		namespace: "controller-agent",
		labels: map[string]string{
			"core.controller-agent.dev/toolrun": "demo",
			"core.controller-agent.dev/tool":    "github",
		},
		annotations:        map[string]string{SessionIDAnnotation: "session-abc"},
		image:              "ghcr.io/imaustink/github-tool:latest",
		serviceAccountName: "tool-runner",
		args:               []string{"issue", "list"},
		staticEnv:          []toolv1alpha1.EnvVar{{Name: "LOG_LEVEL", Value: "debug"}},
		secretEnv: []toolv1alpha1.SecretEnvVar{{
			Name:      "GITHUB_TOKEN",
			SecretRef: toolv1alpha1.SecretKeySelector{Name: "toolrun-demo-identity", Key: "token"},
		}},
		initContainers: []toolv1alpha1.InitContainer{{
			Name:  "seed-credentials",
			Image: "busybox:1.36",
			Args:  []string{"sh", "-c", "echo seeded"},
		}},
		resources: toolv1alpha1.ResourceRequirements{
			Requests: map[string]string{"cpu": "100m", "memory": "128Mi"},
			Limits:   map[string]string{"cpu": "500m", "memory": "512Mi"},
		},
		callback: toolv1alpha1.ToolRunCallback{
			URL:       "http://agent-orchestrator-callback:8080",
			SecretRef: toolv1alpha1.SecretKeySelector{Name: "callback-hmac", Key: "secret"},
		},
		timeoutSeconds: 120,
	}
}

// TestBackendsProduceIdenticalPodSpec is the load-bearing test for the whole
// backend split: whatever the Job backend runs, the Sandbox backend must run
// byte-identically. If this ever fails, the two backends have diverged in
// their security contract, credential wiring, or callback protocol, and the
// Sandbox path can no longer be claimed to preserve docs/security.md.
func TestBackendsProduceIdenticalPodSpec(t *testing.T) {
	p := paramsFixture()

	job, err := buildRunJob(p)
	if err != nil {
		t.Fatalf("buildRunJob: %v", err)
	}
	sb, err := buildRunSandbox(p)
	if err != nil {
		t.Fatalf("buildRunSandbox: %v", err)
	}

	if diff := cmp.Diff(job.Spec.Template.Spec, sb.Spec.PodTemplate.Spec); diff != "" {
		t.Errorf("Job and Sandbox pod specs differ (-job +sandbox):\n%s", diff)
	}
}

// The hardened contract from docs/security.md, asserted directly on the
// Sandbox rather than inferred from the parity test, so a future refactor
// that weakened both backends together would still be caught.
func TestSandboxKeepsHardenedContract(t *testing.T) {
	sb, err := buildRunSandbox(paramsFixture())
	if err != nil {
		t.Fatalf("buildRunSandbox: %v", err)
	}
	spec := sb.Spec.PodTemplate.Spec

	if spec.ServiceAccountName != "tool-runner" {
		t.Errorf("serviceAccountName = %q, want tool-runner", spec.ServiceAccountName)
	}
	if spec.SecurityContext == nil || spec.SecurityContext.RunAsUser == nil || *spec.SecurityContext.RunAsUser != jobRunAsUser {
		t.Errorf("pod runAsUser not %d", jobRunAsUser)
	}
	if spec.SecurityContext.SeccompProfile == nil || spec.SecurityContext.SeccompProfile.Type != "RuntimeDefault" {
		t.Error("seccompProfile is not RuntimeDefault")
	}

	c := spec.Containers[0]
	if c.SecurityContext == nil {
		t.Fatal("run container has no securityContext")
	}
	if c.SecurityContext.ReadOnlyRootFilesystem == nil || !*c.SecurityContext.ReadOnlyRootFilesystem {
		t.Error("readOnlyRootFilesystem is not true")
	}
	if c.SecurityContext.AllowPrivilegeEscalation == nil || *c.SecurityContext.AllowPrivilegeEscalation {
		t.Error("allowPrivilegeEscalation is not false")
	}
	if len(c.SecurityContext.Capabilities.Drop) != 1 || c.SecurityContext.Capabilities.Drop[0] != "ALL" {
		t.Error("capabilities are not drop-ALL")
	}
}

// A per-user credential must reach the container as a secretKeyRef, never as a
// literal value. This is the property AX's TaskSpec cannot express (its EnvVar
// is {name, value} strings persisted in the control plane's own store) and the
// reason ADR 0034 exists.
func TestSandboxCredentialsStayAsSecretRefs(t *testing.T) {
	sb, err := buildRunSandbox(paramsFixture())
	if err != nil {
		t.Fatalf("buildRunSandbox: %v", err)
	}

	var found bool
	for _, e := range sb.Spec.PodTemplate.Spec.Containers[0].Env {
		if e.Value != "" && (e.Name == "GITHUB_TOKEN" || e.Name == "RECIPE_CALLBACK_SECRET") {
			t.Errorf("env %q carries a literal value in the Sandbox spec", e.Name)
		}
		if e.Name == "GITHUB_TOKEN" {
			found = true
			if e.ValueFrom == nil || e.ValueFrom.SecretKeyRef == nil {
				t.Fatal("GITHUB_TOKEN is not a secretKeyRef")
			}
			if got := e.ValueFrom.SecretKeyRef.Name; got != "toolrun-demo-identity" {
				t.Errorf("GITHUB_TOKEN secret = %q, want toolrun-demo-identity", got)
			}
		}
	}
	if !found {
		t.Error("GITHUB_TOKEN not present in the Sandbox pod spec")
	}
}

// The Job backend's activeDeadlineSeconds is a duration; the Sandbox backend's
// shutdownTime is an instant. Assert the translation lands in the right window
// and retains the object, since Delete would race the terminal status sync.
func TestSandboxTimeoutBecomesShutdownTime(t *testing.T) {
	p := paramsFixture()
	before := time.Now()
	sb, err := buildRunSandbox(p)
	if err != nil {
		t.Fatalf("buildRunSandbox: %v", err)
	}
	after := time.Now()

	if sb.Spec.ShutdownTime == nil {
		t.Fatal("shutdownTime is nil")
	}
	lo := before.Add(120 * time.Second)
	hi := after.Add(120 * time.Second)
	if sb.Spec.ShutdownTime.Before(&metav1.Time{Time: lo}) || sb.Spec.ShutdownTime.After(hi) {
		t.Errorf("shutdownTime %v outside [%v, %v]", sb.Spec.ShutdownTime, lo, hi)
	}

	if sb.Spec.ShutdownPolicy == nil || *sb.Spec.ShutdownPolicy != sandboxapi.ShutdownPolicyRetain {
		t.Error("shutdownPolicy is not Retain")
	}

	// A run with no timeout anywhere falls back to the same 300s global default
	// the Job backend applies.
	p.timeoutSeconds = 0
	sb, err = buildRunSandbox(p)
	if err != nil {
		t.Fatalf("buildRunSandbox: %v", err)
	}
	if d := time.Until(sb.Spec.ShutdownTime.Time); d < 295*time.Second || d > 305*time.Second {
		t.Errorf("default shutdownTime is %v from now, want ~300s", d)
	}
}

func cond(t string, s metav1.ConditionStatus, reason string) metav1.Condition {
	return metav1.Condition{
		Type:               t,
		Status:             s,
		Reason:             reason,
		LastTransitionTime: metav1.Now(),
	}
}

// TestSuspensionIsNotAFailure covers the race the Act 4 demo caught. Suspending
// terminates the backing pod, and upstream briefly publishes
// Finished=True/PodFailed while that termination settles before dropping the
// condition. Reading conditions ahead of spec.operatingMode latched the run to
// Failed -- terminal, so the reconciler stopped watching and the later resume
// had nothing tracking it.
func TestSuspensionIsNotAFailure(t *testing.T) {
	transient := &sandboxapi.Sandbox{
		Spec: sandboxapi.SandboxSpec{OperatingMode: sandboxapi.OperatingModeSuspended},
		Status: sandboxapi.SandboxStatus{Conditions: []metav1.Condition{
			cond("Ready", metav1.ConditionFalse, "PodFailed"),
			cond("Finished", metav1.ConditionTrue, "PodFailed"),
		}},
	}
	if got, msg := sandboxPhase(transient, ""); got != toolv1alpha1.ToolRunPhaseRunning {
		t.Errorf("mid-suspension phase = %q (%s), want Running", got, msg)
	}

	// Once suspension settles, upstream drops Finished entirely.
	settled := &sandboxapi.Sandbox{
		Spec: sandboxapi.SandboxSpec{OperatingMode: sandboxapi.OperatingModeSuspended},
		Status: sandboxapi.SandboxStatus{Conditions: []metav1.Condition{
			cond("Suspended", metav1.ConditionTrue, "PodTerminated"),
			cond("Ready", metav1.ConditionFalse, "SandboxSuspended"),
		}},
	}
	if got, _ := sandboxPhase(settled, ""); got != toolv1alpha1.ToolRunPhaseRunning {
		t.Errorf("settled suspension phase = %q, want Running", got)
	}

	// And after resume, a genuine completion is still reported.
	resumed := &sandboxapi.Sandbox{
		Spec: sandboxapi.SandboxSpec{OperatingMode: sandboxapi.OperatingModeRunning},
		Status: sandboxapi.SandboxStatus{Conditions: []metav1.Condition{
			cond("Finished", metav1.ConditionTrue, "PodSucceeded"),
		}},
	}
	if got, _ := sandboxPhase(resumed, ""); got != toolv1alpha1.ToolRunPhaseSucceeded {
		t.Errorf("post-resume completion phase = %q, want Succeeded", got)
	}
}

func TestSandboxPhaseMapping(t *testing.T) {
	cases := []struct {
		name       string
		conditions []metav1.Condition
		wantPhase  toolv1alpha1.ToolRunPhase
	}{
		{
			name:      "no conditions yet is Pending",
			wantPhase: toolv1alpha1.ToolRunPhasePending,
		},
		{
			name:       "provisioning is Pending",
			conditions: []metav1.Condition{cond("Ready", metav1.ConditionFalse, "DependenciesNotReady")},
			wantPhase:  toolv1alpha1.ToolRunPhasePending,
		},
		{
			name:       "ready is Running",
			conditions: []metav1.Condition{cond("Ready", metav1.ConditionTrue, "DependenciesReady")},
			wantPhase:  toolv1alpha1.ToolRunPhaseRunning,
		},
		{
			name: "finished+succeeded is Succeeded",
			conditions: []metav1.Condition{
				cond("Ready", metav1.ConditionFalse, "PodSucceeded"),
				cond("Finished", metav1.ConditionTrue, "PodSucceeded"),
			},
			wantPhase: toolv1alpha1.ToolRunPhaseSucceeded,
		},
		{
			name: "finished+failed is Failed",
			conditions: []metav1.Condition{
				cond("Ready", metav1.ConditionFalse, "PodFailed"),
				cond("Finished", metav1.ConditionTrue, "PodFailed"),
			},
			wantPhase: toolv1alpha1.ToolRunPhaseFailed,
		},
		{
			// The timeout path: an expired Sandbox has had its pod torn down
			// and will never report Finished.
			name:       "expired is Failed",
			conditions: []metav1.Condition{cond("Ready", metav1.ConditionFalse, "SandboxExpired")},
			wantPhase:  toolv1alpha1.ToolRunPhaseFailed,
		},
		{
			// A suspended run has not finished. It must not go terminal, or a
			// resume would find a ToolRun the reconciler has stopped watching.
			name: "suspended stays Running",
			conditions: []metav1.Condition{
				cond("Ready", metav1.ConditionFalse, "SandboxSuspended"),
				cond("Suspended", metav1.ConditionTrue, "PodTerminated"),
			},
			wantPhase: toolv1alpha1.ToolRunPhaseRunning,
		},
		{
			// Upstream notes a stale Suspended condition can linger after a
			// resume, so Finished must win over it.
			name: "finished wins over a stale Suspended condition",
			conditions: []metav1.Condition{
				cond("Suspended", metav1.ConditionTrue, "PodTerminated"),
				cond("Finished", metav1.ConditionTrue, "PodSucceeded"),
			},
			wantPhase: toolv1alpha1.ToolRunPhaseSucceeded,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			sb := &sandboxapi.Sandbox{Status: sandboxapi.SandboxStatus{Conditions: tc.conditions}}
			got, msg := sandboxPhase(sb, "carried-over")
			if got != tc.wantPhase {
				t.Errorf("phase = %q, want %q (message %q)", got, tc.wantPhase, msg)
			}
		})
	}
}

func TestResolveExecutionBackend(t *testing.T) {
	sandboxAnn := map[string]string{ExecutionBackendAnnotation: "sandbox"}
	jobAnn := map[string]string{ExecutionBackendAnnotation: "job"}

	cases := []struct {
		name     string
		run      map[string]string
		tool     map[string]string
		env      string
		expected ExecutionBackend
	}{
		{name: "defaults to job", expected: BackendJob},
		{name: "env opts in globally", env: "sandbox", expected: BackendSandbox},
		{name: "unknown env value stays on job", env: "Sandbox", expected: BackendJob},
		{name: "tool annotation opts in", tool: sandboxAnn, expected: BackendSandbox},
		{name: "run annotation opts in", run: sandboxAnn, expected: BackendSandbox},
		{name: "run overrides tool", run: jobAnn, tool: sandboxAnn, expected: BackendJob},
		{name: "run overrides env", run: jobAnn, env: "sandbox", expected: BackendJob},
		{name: "tool overrides env", tool: jobAnn, env: "sandbox", expected: BackendJob},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("AGENT_EXECUTION_BACKEND", tc.env)
			if got := resolveExecutionBackend(tc.run, tc.tool); got != tc.expected {
				t.Errorf("backend = %q, want %q", got, tc.expected)
			}
		})
	}
}
