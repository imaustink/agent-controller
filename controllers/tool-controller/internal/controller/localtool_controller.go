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
	"fmt"
	"regexp"
	"strings"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	toolv1alpha1 "github.com/controller-agent/tool-controller/api/v1alpha1"
)

const localToolConditionReady = "Ready"

// sha256HexPattern matches a lowercase hex sha256 digest (64 hex chars),
// optionally prefixed with "sha256:".
var sha256HexPattern = regexp.MustCompile(`^(sha256:)?[0-9a-f]{64}$`)

// LocalToolReconciler reconciles a LocalTool object. Unlike ToolRun/AgentRun
// it never creates a Job — a LocalTool is executed in-pod by a per-language
// executor sidecar (ADR 0014). This reconciler only validates the spec's
// cross-field constraints (which the CRD's OpenAPI schema can't express) and
// reports them via a Ready condition. The orchestrator re-validates and
// enforces integrity (pinning/checksum/allowlist) again at fetch time.
type LocalToolReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=localtools,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=localtools/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=core.controller-agent.dev,resources=localtools/finalizers,verbs=update

// Reconcile validates that a LocalTool declares a coherent packaging coordinate
// for its runtime (package+pinned version for node/python/go; sourceURL+sha256
// checksum for shell) and sets a Ready condition accordingly.
func (r *LocalToolReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	var lt toolv1alpha1.LocalTool
	if err := r.Get(ctx, req.NamespacedName, &lt); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	problems := validateLocalToolSpec(lt.Spec)

	condition := metav1.Condition{
		Type:               localToolConditionReady,
		Status:             metav1.ConditionTrue,
		Reason:             "SpecValid",
		Message:            "packaging coordinate is valid for the selected runtime",
		ObservedGeneration: lt.Generation,
	}
	if len(problems) > 0 {
		condition.Status = metav1.ConditionFalse
		condition.Reason = "SpecInvalid"
		condition.Message = strings.Join(problems, "; ")
		log.Info("localtool spec invalid", "localtool", lt.Name, "problems", problems)
	}

	meta.SetStatusCondition(&lt.Status.Conditions, condition)
	if err := r.Status().Update(ctx, &lt); err != nil {
		return ctrl.Result{}, err
	}

	if condition.Status == metav1.ConditionFalse {
		return ctrl.Result{RequeueAfter: toolRecheckInterval}, nil
	}
	return ctrl.Result{}, nil
}

// validateLocalToolSpec returns a list of human-readable problems; empty means
// valid. Kept as a free function so it can be unit-tested without a cluster.
func validateLocalToolSpec(spec toolv1alpha1.LocalToolSpec) []string {
	var problems []string
	switch spec.Runtime {
	case "shell":
		if !strings.HasPrefix(spec.SourceURL, "https://") {
			problems = append(problems, "shell runtime requires an https:// sourceURL")
		}
		if !sha256HexPattern.MatchString(spec.Checksum) {
			problems = append(problems, "shell runtime requires a sha256 checksum (integrity of an arbitrary URL)")
		}
	case "node", "python", "go":
		if spec.Package == "" {
			problems = append(problems, fmt.Sprintf("%s runtime requires a package", spec.Runtime))
		}
		if spec.Version == "" {
			problems = append(problems, fmt.Sprintf("%s runtime requires an exact pinned version", spec.Runtime))
		} else if isUnpinnedVersion(spec.Version) {
			problems = append(problems, fmt.Sprintf("version %q must be exact, not a range or tag", spec.Version))
		}
		if spec.Checksum != "" && !sha256HexPattern.MatchString(spec.Checksum) {
			problems = append(problems, "checksum, when set, must be a sha256 digest")
		}
	default:
		// Enum validation on the CRD should prevent this; kept as a backstop.
		problems = append(problems, fmt.Sprintf("unsupported runtime %q", spec.Runtime))
	}
	return problems
}

// isUnpinnedVersion rejects the common range/tag notations so a LocalTool can
// never silently drift to a different (possibly malicious) release.
func isUnpinnedVersion(v string) bool {
	if v == "latest" || v == "*" {
		return true
	}
	return strings.ContainsAny(v, "^~<>= x*")
}

// SetupWithManager sets up the controller with the Manager.
func (r *LocalToolReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		For(&toolv1alpha1.LocalTool{}).
		Named("localtool").
		Complete(r)
}
