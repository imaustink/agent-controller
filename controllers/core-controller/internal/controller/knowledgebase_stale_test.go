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

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	corev1alpha1 "github.com/controller-agent/core-controller/api/v1alpha1"
)

// TestConnectionIsStale is a plain (non-envtest) unit test of the staleness
// rule a KnowledgeBase reports its members against.
func TestConnectionIsStale(t *testing.T) {
	now := time.Date(2026, 9, 19, 12, 0, 0, 0, time.UTC)
	hourly := &metav1.Duration{Duration: time.Hour}

	withSync := func(mode corev1alpha1.ConnectionSyncMode, interval *metav1.Duration, lastReconcile *time.Time) *corev1alpha1.Connection {
		conn := &corev1alpha1.Connection{
			Spec: corev1alpha1.ConnectionSpec{
				Sync: &corev1alpha1.ConnectionSync{Mode: mode, ReconcileInterval: interval},
			},
		}
		if lastReconcile != nil {
			conn.Status.LastReconcileTime = &metav1.Time{Time: *lastReconcile}
		}
		return conn
	}

	at := func(d time.Duration) *time.Time {
		tm := now.Add(d)
		return &tm
	}

	tests := []struct {
		name string
		conn *corev1alpha1.Connection
		want bool
	}{
		{
			name: "no sync block indexes nothing, so cannot be stale",
			conn: &corev1alpha1.Connection{},
			want: false,
		},
		{
			name: "mode none indexes nothing, so cannot be stale",
			conn: withSync(corev1alpha1.ConnectionSyncNone, nil, nil),
			want: false,
		},
		{
			name: "syncing but never reconciled is stale by definition",
			conn: withSync(corev1alpha1.ConnectionSyncPoll, hourly, nil),
			want: true,
		},
		{
			name: "reconciled just now is fresh",
			conn: withSync(corev1alpha1.ConnectionSyncPoll, hourly, at(-time.Minute)),
			want: false,
		},
		{
			name: "one missed pass is within the grace factor",
			conn: withSync(corev1alpha1.ConnectionSyncPoll, hourly, at(-90*time.Minute)),
			want: false,
		},
		{
			name: "past two intervals is stale",
			conn: withSync(corev1alpha1.ConnectionSyncPoll, hourly, at(-150*time.Minute)),
			want: true,
		},
		{
			// Webhook deliveries keep lastSyncTime moving, which is exactly why
			// staleness is judged on lastReconcileTime instead: a lossy stream
			// can make a corpus look current while it quietly is not.
			name: "webhook mode is judged on reconciles, not on webhook syncs",
			conn: func() *corev1alpha1.Connection {
				conn := withSync(corev1alpha1.ConnectionSyncWebhook, hourly, at(-150*time.Minute))
				conn.Status.LastSyncTime = &metav1.Time{Time: now.Add(-time.Minute)}
				return conn
			}(),
			want: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := connectionIsStale(tt.conn, now); got != tt.want {
				t.Errorf("connectionIsStale() = %v, want %v", got, tt.want)
			}
		})
	}
}
