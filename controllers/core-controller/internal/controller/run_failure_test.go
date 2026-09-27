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

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

func failedJob(conds ...batchv1.JobCondition) *batchv1.Job {
	return &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{Name: "run-1", Namespace: "ns"},
		Status:     batchv1.JobStatus{Failed: 1, Conditions: conds},
	}
}

func oomPod(jobName string) *corev1.Pod {
	return &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: jobName + "-abc", Namespace: "ns", Labels: map[string]string{"job-name": jobName}},
		Spec: corev1.PodSpec{Containers: []corev1.Container{{
			Name: "run",
			Resources: corev1.ResourceRequirements{Limits: corev1.ResourceList{
				corev1.ResourceMemory: resource.MustParse("4Gi"),
			}},
		}}},
		Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{
			Name:  "run",
			State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "OOMKilled", ExitCode: 137}},
		}}},
	}
}

var backoffExceeded = batchv1.JobCondition{
	Type: batchv1.JobFailed, Status: corev1.ConditionTrue,
	Reason: "BackoffLimitExceeded", Message: "Job has reached the specified backoff limit",
}

func TestDescribeJobFailure(t *testing.T) {
	cases := []struct {
		name string
		job  *batchv1.Job
		pods []corev1.Pod
		want string
	}{
		{
			name: "OOMKilled container names the memory limit; backoff condition is dropped as redundant",
			job:  failedJob(backoffExceeded),
			pods: []corev1.Pod{*oomPod("run-1")},
			want: `container "run" was OOMKilled (exit code 137, memory limit 4Gi)`,
		},
		{
			name: "evicted pod",
			job:  failedJob(backoffExceeded),
			pods: []corev1.Pod{{Status: corev1.PodStatus{
				Reason:  "Evicted",
				Message: "Pod ephemeral local storage usage exceeds the total limit of containers 8Gi.",
			}}},
			want: "pod Evicted: Pod ephemeral local storage usage exceeds the total limit of containers 8Gi.",
		},
		{
			name: "non-zero exit of an init container",
			job:  failedJob(),
			pods: []corev1.Pod{{Status: corev1.PodStatus{InitContainerStatuses: []corev1.ContainerStatus{{
				Name:  "seed-claude-credentials",
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Error", ExitCode: 1}},
			}}}}},
			want: `container "seed-claude-credentials" was Error (exit code 1)`,
		},
		{
			name: "deadline exceeded with the pod already gone",
			job: failedJob(batchv1.JobCondition{
				Type: batchv1.JobFailed, Status: corev1.ConditionTrue,
				Reason: "DeadlineExceeded", Message: "Job was active longer than specified deadline",
			}),
			want: "DeadlineExceeded: Job was active longer than specified deadline",
		},
		{
			name: "backoff condition is reported when nothing else explains the failure",
			job:  failedJob(backoffExceeded),
			want: "BackoffLimitExceeded: Job has reached the specified backoff limit",
		},
		{
			name: "a clean exit is not a failure cause",
			job:  failedJob(),
			pods: []corev1.Pod{{Status: corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{
				Name:  "run",
				State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{Reason: "Completed", ExitCode: 0}},
			}}}}},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := describeJobFailure(tc.job, tc.pods); got != tc.want {
				t.Errorf("describeJobFailure() =\n  %q\nwant\n  %q", got, tc.want)
			}
		})
	}
}

func TestFailedRunMessage(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()

	t.Run("reads the failed Job's own pod by job-name label", func(t *testing.T) {
		// A second, unrelated OOM pod must not be attributed to this Job.
		other := oomPod("other-job")
		other.Spec.Containers[0].Name = "elsewhere"
		other.Status.ContainerStatuses[0].Name = "elsewhere"
		reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(oomPod("run-1"), other).Build()

		got := failedRunMessage(ctx, reader, failedJob(backoffExceeded), toolv1alpha1.ToolRunPhaseRunning, "")
		want := `Job failed: container "run" was OOMKilled (exit code 137, memory limit 4Gi)`
		if got != want {
			t.Errorf("got %q, want %q", got, want)
		}
	})

	t.Run("keeps the message recorded on the transition once the run is already Failed", func(t *testing.T) {
		// The pod is gone (TTL) by now; re-deriving would downgrade the message.
		reader := fake.NewClientBuilder().WithScheme(scheme).Build()
		recorded := `Job failed: container "run" was OOMKilled (exit code 137, memory limit 4Gi)`
		got := failedRunMessage(ctx, reader, failedJob(backoffExceeded), toolv1alpha1.ToolRunPhaseFailed, recorded)
		if got != recorded {
			t.Errorf("got %q, want the previously recorded %q", got, recorded)
		}
	})

	t.Run("falls back to the generic message with no reader and no Job condition", func(t *testing.T) {
		if got := failedRunMessage(ctx, nil, failedJob(), toolv1alpha1.ToolRunPhaseRunning, ""); got != genericJobFailedMessage {
			t.Errorf("got %q, want %q", got, genericJobFailedMessage)
		}
	})
}
