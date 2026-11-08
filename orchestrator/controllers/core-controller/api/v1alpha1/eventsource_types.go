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

package v1alpha1

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
)

// WebhookVerifyScheme is how integration-gateway authenticates a delivery
// before parsing it (docs/event-triggers.md §1). There is deliberately no
// "none": an inbound source that cannot be authenticated is not a source.
// +kubebuilder:validation:Enum=hmacSha256;slackV0;bearer
type WebhookVerifyScheme string

const (
	WebhookVerifyHMACSHA256 WebhookVerifyScheme = "hmacSha256"
	WebhookVerifySlackV0    WebhookVerifyScheme = "slackV0"
	WebhookVerifyBearer     WebhookVerifyScheme = "bearer"
)

// WebhookVerify configures signature/token verification over the raw body.
// +kubebuilder:validation:XValidation:rule="self.scheme != 'hmacSha256' || (has(self.header) && size(self.header) > 0)",message="hmacSha256 requires header"
type WebhookVerify struct {
	// scheme selects the verification algorithm.
	// +required
	Scheme WebhookVerifyScheme `json:"scheme"`

	// header carries the signature (hmacSha256) or token (bearer; default
	// "authorization", which expects "Bearer <secret>"). Ignored for slackV0.
	// +optional
	Header string `json:"header,omitempty"`

	// prefix is stripped from the hmacSha256 signature header before the hex
	// comparison (e.g. "sha256=" for GitHub).
	// +optional
	Prefix string `json:"prefix,omitempty"`

	// secretRef names the shared secret (same namespace).
	// +required
	SecretRef SecretKeySelector `json:"secretRef"`
}

// WebhookSource is an HTTP source, served at POST /webhooks/<EventSource name>.
type WebhookSource struct {
	// verify authenticates every delivery before it is parsed.
	// +required
	Verify WebhookVerify `json:"verify"`

	// deliveryIdHeader names the header carrying the sender's delivery id
	// (envelope.id). Absent, the gateway generates one.
	// +optional
	DeliveryIDHeader string `json:"deliveryIdHeader,omitempty"`
}

// CronSource is a timer source. core-controller materializes it as an owned
// CronJob that ticks integration-gateway (docs/event-triggers.md §8).
type CronSource struct {
	// schedule in standard 5-field cron syntax.
	// +required
	// +kubebuilder:validation:MinLength=1
	Schedule string `json:"schedule"`

	// timeZone is an IANA zone name for the schedule; absent means the
	// kube-controller-manager's zone (usually UTC).
	// +optional
	TimeZone string `json:"timeZone,omitempty"`

	// suspend pauses ticking without deleting the source.
	// +optional
	Suspend bool `json:"suspend,omitempty"`

	// payload is an arbitrary JSON object delivered as envelope.body on every
	// tick, so triggers extract params from a cron event exactly as they would
	// from a webhook.
	// +optional
	// +kubebuilder:pruning:PreserveUnknownFields
	// +kubebuilder:validation:Schemaless
	// +kubebuilder:validation:Type=object
	Payload *runtime.RawExtension `json:"payload,omitempty"`
}

// EventSenderProvider is how a sender's login is verified.
// +kubebuilder:validation:Enum=github
type EventSenderProvider string

const EventSenderProviderGitHub EventSenderProvider = "github"

// EventSender extracts and verifies who caused a webhook event. A login is
// only ever forwarded as the turn's principal after the provider verifies
// it; a source without a sender runs as the gateway's own service identity.
type EventSender struct {
	// provider verifies the extracted login (GitHub team/collaborator roles).
	// +required
	Provider EventSenderProvider `json:"provider"`

	// loginFrom is a CEL expression over the envelope yielding the login.
	// +required
	// +kubebuilder:validation:MinLength=1
	LoginFrom string `json:"loginFrom"`

	// isBotFrom is a CEL expression yielding whether the sender is a bot.
	// +optional
	IsBotFrom string `json:"isBotFrom,omitempty"`

	// repositoryFrom is a CEL expression yielding "owner/name": the
	// repository the sender's permission is checked on and the turn's target
	// repository (ADR 0042).
	// +optional
	RepositoryFrom string `json:"repositoryFrom,omitempty"`

	// dropBots drops bot-authored events so an agent cannot trigger itself.
	// +optional
	// +kubebuilder:default=true
	DropBots *bool `json:"dropBots,omitempty"`
}

// EventSourceSpec is exactly one of webhook / cron.
// +kubebuilder:validation:XValidation:rule="(has(self.webhook)?1:0)+(has(self.cron)?1:0)==1",message="exactly one of webhook or cron must be set"
// +kubebuilder:validation:XValidation:rule="!has(self.sender) || has(self.webhook)",message="sender is only valid for webhook sources"
type EventSourceSpec struct {
	// webhook makes this an HTTP source.
	// +optional
	Webhook *WebhookSource `json:"webhook,omitempty"`

	// cron makes this a timer source.
	// +optional
	Cron *CronSource `json:"cron,omitempty"`

	// sender identifies who caused a webhook event.
	// +optional
	Sender *EventSender `json:"sender,omitempty"`
}

// EventSourceStatus defines the observed state of EventSource.
type EventSourceStatus struct {
	// cronJobName is the CronJob materialized for a cron source.
	// +optional
	CronJobName string `json:"cronJobName,omitempty"`

	// conditions; "Ready" reports whether the source can deliver events.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:printcolumn:name="Schedule",type=string,JSONPath=".spec.cron.schedule"
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// EventSource declares how events arrive and how far they are trusted
// (docs/adr/0048): an authenticated webhook or a cron schedule. Every source
// produces the same normalized envelope for EventTriggers to match.
type EventSource struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of EventSource
	// +required
	Spec EventSourceSpec `json:"spec"`

	// status defines the observed state of EventSource
	// +optional
	Status EventSourceStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// EventSourceList contains a list of EventSource
type EventSourceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []EventSource `json:"items"`
}

func init() {
	SchemeBuilder.Register(&EventSource{}, &EventSourceList{})
}
