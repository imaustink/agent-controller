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
)

// EDIT THIS FILE!  THIS IS SCAFFOLDING FOR YOU TO OWN!
// NOTE: json tags are required.  Any new fields you add must have json tags for the fields to be serialized.

// KnowledgeBaseChunking sets the default chunking for this knowledge base.
//
// Defaults only: each provider driver overrides them, because these corpora do
// not chunk alike (ADR 0039 §6). A Confluence page is prose and chunks by
// heading; a Slack channel is thousands of short, interleaved, thread-nested
// messages that want thread-aware grouping with author and timestamp preserved
// in the chunk text. Chunk quality, not CRD design, decides whether the answers
// are any good.
type KnowledgeBaseChunking struct {
	// maxTokens is the target upper bound for one chunk.
	// +optional
	// +kubebuilder:default=800
	// +kubebuilder:validation:Minimum=64
	MaxTokens int32 `json:"maxTokens,omitempty"`

	// overlap is how many tokens adjacent chunks share, so a passage split
	// across a boundary is still retrievable from either side.
	// +optional
	// +kubebuilder:default=100
	// +kubebuilder:validation:Minimum=0
	Overlap int32 `json:"overlap,omitempty"`
}

// KnowledgeBaseSpec defines the desired state of KnowledgeBase.
//
// A KnowledgeBase composes Connections (ADR 0038) into the thing an agent
// actually asks questions of — a client engagement, not a single source. The
// composition is many-to-many and expected to churn: one knowledge base draws
// on several Connections including repeats of one provider (two Slack
// channels), and one Connection may belong to several knowledge bases (a
// shared announcements channel is context for every client).
//
// The indexer derives a Skill from this resource (ADR 0039 §2), whose toolRefs
// are this knowledge base's own search/fetch tools plus each member
// Connection's GET face. That is what makes a knowledge base's tools reachable
// ONLY once the agent has selected it — reusing the tool scoping that skill
// selection already performs, rather than adding a selection path.
// +kubebuilder:validation:XValidation:rule="!has(self.chunk) || !has(self.chunk.overlap) || !has(self.chunk.maxTokens) || self.chunk.overlap < self.chunk.maxTokens",message="chunk.overlap must be smaller than chunk.maxTokens"
type KnowledgeBaseSpec struct {
	// description is embedded for retrieval, and is SUBJECT MATTER rather than
	// a tool contract: what this engagement is, which systems it spans, what
	// people call it. This is how the planner tells twenty client knowledge
	// bases apart, so near-identical descriptions defeat the whole design
	// (ADR 0039 §5).
	// +required
	// +kubebuilder:validation:MinLength=1
	Description string `json:"description"`

	// displayName is the human name for this knowledge base (e.g. "SNC").
	// Defaults to metadata.name.
	// +optional
	DisplayName string `json:"displayName,omitempty"`

	// aliases are also embedded: the client's real name, project codenames,
	// the systems involved — whatever someone might actually say instead of
	// the knowledge base's name.
	// +optional
	// +listType=set
	Aliases []string `json:"aliases,omitempty"`

	// corpusRefs names the Corpus CRs (same namespace) composing this
	// knowledge base. Repeats of one provider are expected and supported; give
	// them distinct Corpus displayNames so citations can tell them apart.
	//
	// An explicit list rather than a label selector: which sources compose a
	// client's knowledge base is worth reviewing in a diff, and a mistyped
	// selector silently widening a client boundary is a bad failure mode.
	// +required
	// +kubebuilder:validation:MinItems=1
	// +listType=set
	CorpusRefs []string `json:"corpusRefs"`

	// chunk sets default chunking. See KnowledgeBaseChunking.
	// +optional
	Chunk *KnowledgeBaseChunking `json:"chunk,omitempty"`

	// disclosePartialVisibility makes a search report how many member
	// Connections were withheld from this caller by role, so the agent can
	// distinguish "nothing exists about this" from "nothing you may see exists
	// about this".
	//
	// Default true. It is minor metadata disclosure and can be turned off, but
	// silence is the worse default: a confidently wrong "there's nothing about
	// that" is the failure a knowledge base exists to prevent (ADR 0039 §4).
	// +optional
	// +kubebuilder:default=true
	DisclosePartialVisibility *bool `json:"disclosePartialVisibility,omitempty"`

	// NOTE: there is deliberately no allowedRoles here. Like a Skill (ADR 0011
	// — "skills aren't dangerous, tools are"), a KnowledgeBase carries no RBAC
	// of its own; its audience is derived from its member Connections. Unlike a
	// Skill, the derivation is a UNION rather than an intersection, because one
	// restricted member must not hide an entire client knowledge base from
	// everyone else. Per-chunk role filtering at the vector store then decides
	// what any given caller actually sees (ADR 0039 §4).
}

// KnowledgeBaseCorpusStatus is one member Corpus's contribution.
type KnowledgeBaseCorpusStatus struct {
	// name of the member Connection.
	// +required
	Name string `json:"name"`

	// documents contributed by this Connection as of its last sync.
	// +optional
	Documents int64 `json:"documents,omitempty"`

	// lastSyncTime copied from the Connection, so one read of the knowledge
	// base shows which member is lagging.
	// +optional
	LastSyncTime *metav1.Time `json:"lastSyncTime,omitempty"`
}

// KnowledgeBaseStatus defines the observed state of KnowledgeBase.
type KnowledgeBaseStatus struct {
	// documents across every member Connection.
	// +optional
	Documents int64 `json:"documents,omitempty"`

	// perConnection breaks that down by member.
	// +listType=map
	// +listMapKey=name
	// +optional
	PerCorpus []KnowledgeBaseCorpusStatus `json:"perCorpus,omitempty"`

	// staleCorpora are members whose last full reconcile is older than
	// their own reconcileInterval allows — the corpus is answerable but some of
	// it is out of date, which a cited answer should be able to admit.
	// +optional
	// +listType=set
	StaleCorpora []string `json:"staleCorpora,omitempty"`

	// missingCorpora are corpusRefs with no matching Corpus CR.
	// Surfaced rather than ignored: a dangling ref means the knowledge base
	// silently answers from less than it claims to cover.
	// +optional
	// +listType=set
	MissingCorpora []string `json:"missingCorpora,omitempty"`

	// observedGeneration is the .metadata.generation this status reflects.
	// +optional
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`

	// conditions represent the current state of the KnowledgeBase resource.
	// This controller uses "Ready" to report that every ref resolves.
	// +listType=map
	// +listMapKey=type
	// +optional
	Conditions []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:shortName=kb
// +kubebuilder:printcolumn:name="Documents",type=integer,JSONPath=".status.documents"
// +kubebuilder:printcolumn:name="Ready",type=string,JSONPath=".status.conditions[?(@.type=='Ready')].status"
// +kubebuilder:printcolumn:name="Stale",type=string,JSONPath=".status.staleConnections",priority=1
// +kubebuilder:printcolumn:name="Age",type=date,JSONPath=".metadata.creationTimestamp"

// KnowledgeBase is the Schema for the knowledgebases API
type KnowledgeBase struct {
	metav1.TypeMeta `json:",inline"`

	// metadata is a standard object metadata
	// +optional
	metav1.ObjectMeta `json:"metadata,omitzero"`

	// spec defines the desired state of KnowledgeBase
	// +required
	Spec KnowledgeBaseSpec `json:"spec"`

	// status defines the observed state of KnowledgeBase
	// +optional
	Status KnowledgeBaseStatus `json:"status,omitzero"`
}

// +kubebuilder:object:root=true

// KnowledgeBaseList contains a list of KnowledgeBase
type KnowledgeBaseList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitzero"`
	Items           []KnowledgeBase `json:"items"`
}

func init() {
	SchemeBuilder.Register(&KnowledgeBase{}, &KnowledgeBaseList{})
}
