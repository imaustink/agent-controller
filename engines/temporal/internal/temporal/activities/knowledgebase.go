package activities

import (
	"context"
	"fmt"
	"sort"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

const SearchKnowledgeBaseActivityName = "SearchKnowledgeBase"

// defaultKnowledgeBaseLimit is how many passages an answer gets. The candidate
// set probed to produce them is this times corpus.DefaultCandidateMultiplier.
const defaultKnowledgeBaseLimit = 6

// DelegatedCredentialResolver hands back the calling user's own token for a
// provider.
//
// An interface, and resolved INSIDE this activity, for the reason
// AuthorizeActivities states: the activity boundary is the credential boundary.
// An activity result is persisted to Temporal event history, so a token
// returned to the workflow would be durable plaintext for the workflow's whole
// retention. This one never leaves the activity.
type DelegatedCredentialResolver interface {
	DelegatedToken(ctx context.Context, caller Caller, providers []string) (string, error)
}

// KnowledgeBaseActivities executes the generated search tool (ADR 0039 §3).
//
// Retrieval runs here rather than as a launched ToolRun because there is
// nothing to launch: a knowledge base's search is a vector query plus a probe,
// both of which are network calls this engine already performs from activities.
type KnowledgeBaseActivities struct {
	Corpora     *vectorstore.Corpora
	Credentials DelegatedCredentialResolver
	BrokerURL   string
	BrokerToken string
}

type SearchKnowledgeBaseInput struct {
	Caller Caller `json:"caller"`
	// Tool is the resolved descriptor, carrying the execution spec snapshotted
	// at index time — so this runs over exactly the membership the planner was
	// offered.
	Tool  catalog.ToolDescriptor `json:"tool"`
	Query string                 `json:"query"`
	Limit int                    `json:"limit,omitempty"`
}

// SearchKnowledgeBaseOutput carries prose, never a credential.
type SearchKnowledgeBaseOutput struct {
	// Result is the Markdown composition frames verbatim (ADR 0015).
	Result string `json:"result"`
	// NeedsLink is set when the caller has not linked the credential this
	// knowledge base's sources require. The turn then asks them to, rather than
	// answering from a corpus it could not check.
	NeedsLink bool `json:"needsLink,omitempty"`
}

// SearchKnowledgeBase probes and renders one knowledge-base search.
func (a *KnowledgeBaseActivities) SearchKnowledgeBase(
	ctx context.Context,
	in SearchKnowledgeBaseInput,
) (SearchKnowledgeBaseOutput, error) {
	exec := in.Tool.KnowledgeBaseExec
	if exec == nil {
		return SearchKnowledgeBaseOutput{}, fmt.Errorf("tool %s carries no knowledge-base execution spec", in.Tool.ID)
	}
	// This activity only knows how to search. A "fetch" operation would need a
	// whole-document read from the source, an adapter ADR 0040 defers — so no
	// fetch tool is generated. Fail closed rather than let a mis-generated
	// fetch spec silently run a similarity search over the source id, which
	// would return ranked passages dressed up as a document fetch.
	if exec.Operation != "" && exec.Operation != "search" {
		return SearchKnowledgeBaseOutput{
			Result: fmt.Sprintf(
				"I cannot %s %s: only search is supported for this knowledge base.",
				exec.Operation, exec.DisplayName),
		}, nil
	}
	if in.Caller.Subject == "" {
		// Fail closed, as every retrieval in this engine does: no resolved
		// identity means no corpus.
		return SearchKnowledgeBaseOutput{Result: "I could not establish who is asking, so I cannot search this knowledge base."}, nil
	}

	visible, withheld := visibleMembers(exec.Members, in.Caller.Roles)
	if len(visible) == 0 {
		return SearchKnowledgeBaseOutput{
			Result: corpus.Render(corpus.RenderInput{
				Withheld: withheld,
				Disclose: exec.DisclosePartialVisibility,
			}),
		}, nil
	}

	token, err := a.Credentials.DelegatedToken(ctx, in.Caller, providersOf(visible))
	if err != nil {
		return SearchKnowledgeBaseOutput{}, err
	}
	if token == "" {
		// Without the caller's own credential nothing can be probed, and
		// probing on the ingestion credential would answer a different
		// question, permissively (ADR 0040). Asking for a link is the only
		// honest response.
		return SearchKnowledgeBaseOutput{
			NeedsLink: true,
			Result: fmt.Sprintf(
				"I need you to link the account behind %s before I can search it — every result has to be "+
					"checked against your own access to the source.", exec.DisplayName),
		}, nil
	}

	stores, skipped, err := a.Corpora.Resolve(ctx, collectionsOf(visible))
	if err != nil {
		return SearchKnowledgeBaseOutput{}, err
	}

	outcome, err := corpus.Retrieve(ctx, stores, a.prober(token, visible), in.Query,
		in.Caller.Roles, knowledgeBaseLimit(in.Limit), corpus.DefaultCandidateMultiplier)
	if err != nil {
		return SearchKnowledgeBaseOutput{}, err
	}
	// Corpora it could not open and corpora that failed mid-query are the same
	// gap to the person reading the answer.
	outcome.SkippedCorpora += skipped

	return SearchKnowledgeBaseOutput{
		Result: corpus.Render(corpus.RenderInput{
			Outcome:  outcome,
			Withheld: withheld,
			Disclose: exec.DisclosePartialVisibility,
		}),
	}, nil
}

func (a *KnowledgeBaseActivities) prober(token string, members []catalog.KnowledgeBaseExecMember) corpus.Prober {
	granularities := make(map[string]corpus.Granularity, len(members))
	for _, member := range members {
		if member.Granularity == string(corpus.GranularityConnection) {
			granularities[member.ID] = corpus.GranularityConnection
			continue
		}
		granularities[member.ID] = corpus.GranularityResource
	}
	return &corpus.BrokerProber{
		BaseURL:        a.BrokerURL,
		Token:          a.BrokerToken,
		DelegatedToken: token,
		Granularities:  granularities,
	}
}

// visibleMembers is the source-level access filter (ADR 0039 §4): which members
// this caller may consult at all, and how many were withheld.
//
// Doing it here is what makes the COUNT available. Once a role-filtered query
// has run it cannot report what it declined to return, and "nothing matched"
// and "nothing you may see matched" become indistinguishable — which is the
// failure a knowledge base exists to prevent.
//
// A member with no collection is counted as withheld rather than visible: there
// is nothing indexed to search, and that is still something the answer is
// missing.
func visibleMembers(members []catalog.KnowledgeBaseExecMember, callerRoles []string) ([]catalog.KnowledgeBaseExecMember, int) {
	held := make(map[string]struct{}, len(callerRoles))
	for _, role := range callerRoles {
		held[role] = struct{}{}
	}

	visible := make([]catalog.KnowledgeBaseExecMember, 0, len(members))
	withheld := 0
	for _, member := range members {
		allowed := false
		for _, role := range member.AllowedRoles {
			if _, ok := held[role]; ok {
				allowed = true
				break
			}
		}
		if !allowed || member.Collection == "" {
			withheld++
			continue
		}
		visible = append(visible, member)
	}
	return visible, withheld
}

func collectionsOf(members []catalog.KnowledgeBaseExecMember) []string {
	out := make([]string, 0, len(members))
	for _, member := range members {
		out = append(out, member.Collection)
	}
	return out
}

// providersOf is the union of identity providers the visible members need,
// sorted so the resolver sees a stable request.
func providersOf(members []catalog.KnowledgeBaseExecMember) []string {
	set := map[string]struct{}{}
	for _, member := range members {
		for _, provider := range member.IdentityProviders {
			set[provider] = struct{}{}
		}
	}
	out := make([]string, 0, len(set))
	for provider := range set {
		out = append(out, provider)
	}
	sort.Strings(out)
	return out
}

func knowledgeBaseLimit(requested int) int {
	if requested > 0 {
		return requested
	}
	return defaultKnowledgeBaseLimit
}
