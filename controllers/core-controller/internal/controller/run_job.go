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
	"fmt"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/utils/ptr"

	toolv1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

// runJobParams is everything the shared hardened-Job builder needs, shaped
// so both ToolRun (tool image + args) and AgentRun (agent image + goal)
// reconcilers produce byte-identical security/callback wiring.
type runJobParams struct {
	// jobName must be unique per run; convention: "<kind>-<run name>".
	jobName   string
	namespace string
	labels    map[string]string

	image              string
	serviceAccountName string
	args               []string
	staticEnv          []toolv1alpha1.EnvVar
	secretEnv          []toolv1alpha1.SecretEnvVar
	resources          toolv1alpha1.ResourceRequirements

	callback       toolv1alpha1.ToolRunCallback
	timeoutSeconds int32
}

// buildRunJob builds the hardened one-shot Job every run kind launches
// (ADR 0010). Supports two result-delivery modes:
//   - HTTP callback (callback.URL set): injects RECIPE_TRANSPORT=callback,
//     RECIPE_CALLBACK_URL, and RECIPE_CALLBACK_SECRET (secretKeyRef).
//   - NATS (callback.NatsSubject set): injects RECIPE_TRANSPORT=nats,
//     RECIPE_NATS_SUBJECT, and RECIPE_NATS_URL. No HMAC secret required.
//
// Exactly one of the two modes must be configured; an error is returned if
// neither URL nor NatsSubject is non-empty.
func buildRunJob(p runJobParams) (*batchv1.Job, error) {
	if p.callback.URL == "" && p.callback.NatsSubject == "" {
		return nil, fmt.Errorf("job %s/%s: callback must set either url or natsSubject", p.namespace, p.jobName)
	}

	timeout := defaultTimeoutSeconds
	if p.timeoutSeconds > 0 {
		timeout = int64(p.timeoutSeconds)
	}

	env := make([]corev1.EnvVar, 0, len(p.staticEnv)+len(p.secretEnv)+3)
	for _, e := range p.staticEnv {
		env = append(env, corev1.EnvVar{Name: e.Name, Value: e.Value})
	}
	for _, e := range p.secretEnv {
		env = append(env, corev1.EnvVar{
			Name: e.Name,
			ValueFrom: &corev1.EnvVarSource{
				SecretKeyRef: &corev1.SecretKeySelector{
					LocalObjectReference: corev1.LocalObjectReference{Name: e.SecretRef.Name},
					Key:                  e.SecretRef.Key,
				},
			},
		})
	}

	if p.callback.NatsSubject != "" {
		// NATS delivery mode: no HMAC secret needed; subject is the capability.
		env = append(env,
			corev1.EnvVar{Name: "RECIPE_TRANSPORT", Value: "nats"},
			corev1.EnvVar{Name: "RECIPE_NATS_SUBJECT", Value: p.callback.NatsSubject},
			corev1.EnvVar{Name: "RECIPE_NATS_URL", Value: p.callback.NatsUrl},
		)
	} else {
		// HTTP callback mode (backward-compatible default).
		env = append(env,
			corev1.EnvVar{Name: "RECIPE_TRANSPORT", Value: "callback"},
			corev1.EnvVar{Name: "RECIPE_CALLBACK_URL", Value: p.callback.URL},
			corev1.EnvVar{
				Name: "RECIPE_CALLBACK_SECRET",
				ValueFrom: &corev1.EnvVarSource{
					SecretKeyRef: &corev1.SecretKeySelector{
						LocalObjectReference: corev1.LocalObjectReference{Name: p.callback.SecretRef.Name},
						Key:                  p.callback.SecretRef.Key,
					},
				},
			},
		)
	}

	resources, err := toCoreResourceRequirements(p.resources)
	if err != nil {
		return nil, err
	}

	job := &batchv1.Job{
		ObjectMeta: metav1.ObjectMeta{
			Name:      p.jobName,
			Namespace: p.namespace,
			Labels:    p.labels,
		},
		Spec: batchv1.JobSpec{
			ActiveDeadlineSeconds:   ptr.To(timeout),
			TTLSecondsAfterFinished: ptr.To(defaultTTLSecondsAfterFinished),
			BackoffLimit:            ptr.To(int32(0)),
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: p.labels,
				},
				Spec: corev1.PodSpec{
					ServiceAccountName: p.serviceAccountName,
					RestartPolicy:      corev1.RestartPolicyNever,
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: ptr.To(true),
						RunAsUser:    ptr.To(jobRunAsUser),
						RunAsGroup:   ptr.To(jobRunAsGroup),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Volumes: []corev1.Volume{
						{Name: "tmp", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}},
					},
					Containers: []corev1.Container{
						{
							Name:  "run",
							Image: p.image,
							// Explicit, rather than relying on k8s's default (which is
							// "Always" for a ":latest" tag) -- tool/agent images in this
							// repo are built straight into the cluster's own container
							// runtime (e.g. minikube's docker daemon) for local/dev use,
							// never pushed to a registry, so "Always" would wrongly try
							// to pull from Docker Hub and fail with ImagePullBackOff.
							ImagePullPolicy: corev1.PullIfNotPresent,
							Args:            p.args,
							Env:             env,
							Resources:       resources,
							VolumeMounts: []corev1.VolumeMount{
								{Name: "tmp", MountPath: "/tmp"},
							},
							SecurityContext: &corev1.SecurityContext{
								AllowPrivilegeEscalation: ptr.To(false),
								ReadOnlyRootFilesystem:   ptr.To(true),
								RunAsNonRoot:             ptr.To(true),
								Capabilities:             &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
							},
						},
					},
				},
			},
		},
	}
	return job, nil
}

// jobPhase maps an observed Job's status to the shared run-phase enum, plus
// a human-readable message. Used by both ToolRun and AgentRun status sync.
func jobPhase(job *batchv1.Job, currentMessage string) (toolv1alpha1.ToolRunPhase, string) {
	switch {
	case job.Status.Succeeded > 0:
		return toolv1alpha1.ToolRunPhaseSucceeded, "Job completed successfully"
	case job.Status.Failed > 0:
		return toolv1alpha1.ToolRunPhaseFailed, "Job failed (see Job/Pod events for detail)"
	case job.Status.Active == 0 && job.Status.StartTime == nil:
		return toolv1alpha1.ToolRunPhasePending, currentMessage
	default:
		return toolv1alpha1.ToolRunPhaseRunning, currentMessage
	}
}

func toCoreResourceRequirements(spec toolv1alpha1.ResourceRequirements) (corev1.ResourceRequirements, error) {
	requests, err := parseResourceList(spec.Requests)
	if err != nil {
		return corev1.ResourceRequirements{}, err
	}
	limits, err := parseResourceList(spec.Limits)
	if err != nil {
		return corev1.ResourceRequirements{}, err
	}
	return corev1.ResourceRequirements{Requests: requests, Limits: limits}, nil
}

func parseResourceList(m map[string]string) (corev1.ResourceList, error) {
	if len(m) == 0 {
		return nil, nil
	}
	out := make(corev1.ResourceList, len(m))
	for k, v := range m {
		qty, err := resource.ParseQuantity(v)
		if err != nil {
			return nil, fmt.Errorf("invalid resource quantity %q for %q: %w", v, k, err)
		}
		out[corev1.ResourceName(k)] = qty
	}
	return out, nil
}
