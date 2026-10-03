package activities

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/identitylink"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

const SearchKnowledgeBaseActivityName = "SearchKnowledgeBase"

// defaultKnowledgeBaseLimit is how many passages an answer gets. The candidate
// set probed to produce them is this times corpus.DefaultCandidateMultiplier.
//
// Six starved multi-document questions: a "what are all our projects for X"
// drew on one source and read as thin. Twelve gives the model enough spread to
// synthesise across sources while staying well inside the context budget (a
// chunk is capped at 800 tokens at ingest). PARITY: DEFAULT_LIMIT in the TS
// searcher.
const defaultKnowledgeBaseLimit = 12

// DelegatedCredentialResolver hands back the calling user's own token for a
// provider.
//
// An interface, and resolved INSIDE this activity, for the reason
// AuthorizeActivities states: the activity boundary is the credential boundary.
// An activity result is persisted to Temporal event history, so a token
// returned to the workflow would be durable plaintext for the workflow's whole
// retention. This one never leaves the activity.
type DelegatedCredentialResolver interface {
	// DelegatedToken is the first linked provider's credential — for
	// single-connection callers (the document reader, the live lookup) that only
	// ever touch one provider.
	DelegatedToken(ctx context.Context, caller Caller, providers []string) (DelegatedCredential, error)
	// DelegatedTokens is a credential per linked provider, keyed by provider
	// name. The multi-member search uses this so a knowledge base spanning
	// providers probes each source with the token for ITS provider, and asks for
	// the rest.
	DelegatedTokens(ctx context.Context, caller Caller, providers []string) (map[string]DelegatedCredential, error)
}

// CorpusResolver opens the Stores for a set of member collections, skipping any
// that cannot be opened and reporting how many were skipped.
//
// An interface so the activity can be exercised without a live vector store;
// *vectorstore.Corpora is the production implementation.
//
// PARITY: the TS searcher's injected `openCorpus` factory.
type CorpusResolver interface {
	Resolve(ctx context.Context, collections []string) ([]vectorstore.Store, int, error)
}

// DelegatedCredential is the caller's own credential for a provider, plus the
// identities that credential represents at that provider.
//
// Principals are carried alongside the token rather than derived later because
// only the credential store knows them: they are provider-shaped
// ("user:<accountId>", "group:<id>"), not the cluster-side Subject or Roles.
// They feed the ACL mirror's pre-filter and nothing else — a missing or partial
// set costs probes, never correctness (see corpus.PreFilter, which is written
// to be safe against exactly that).
type DelegatedCredential struct {
	Token string
	// Principals may legitimately be empty, or cover only some kinds — group
	// membership in particular needs a provider call that may not have
	// happened. PreFilter degrades accordingly rather than excluding on a kind
	// it cannot evaluate.
	Principals []string
}

// KnowledgeBaseActivities executes the generated search tool (ADR 0039 §3).
//
// Retrieval runs here rather than as a launched ToolRun because there is
// nothing to launch: a knowledge base's search is a vector query plus a probe,
// both of which are network calls this engine already performs from activities.
type KnowledgeBaseActivities struct {
	Corpora     CorpusResolver
	Credentials DelegatedCredentialResolver
	BrokerURL   string
	BrokerToken string
	// IdentityLinks starts the OAuth flow when a caller must link an account, so
	// the "needs link" answer carries a clickable link rather than a dead-end
	// sentence. Optional: without it the ask degrades to the plain message.
	IdentityLinks identitylink.Port
}

type SearchKnowledgeBaseInput struct {
	Caller Caller `json:"caller"`
	// Tool is the resolved descriptor, carrying the execution spec snapshotted
	// at index time — so this runs over exactly the membership the planner was
	// offered.
	Tool  catalog.ToolDescriptor `json:"tool"`
	Query string                 `json:"query"`
	Limit int                    `json:"limit,omitempty"`
	// GateOnly runs the deterministic pre-search link check and nothing else:
	// it resolves which of this knowledge base's providers the caller has not
	// linked and renders the clickable ask, WITHOUT running the vector query or
	// probe. The workflow calls it once per knowledge base per conversation and
	// stops the turn when LinkProviders comes back non-empty, so the caller is
	// told what to link rather than handed a partial answer whose "link this
	// too" line the planner might drop (a core auth behaviour must not depend on
	// the model echoing a caveat). An empty LinkProviders means nothing is
	// missing and the caller should proceed to the real search.
	GateOnly bool `json:"gateOnly,omitempty"`
}

// SearchKnowledgeBaseOutput carries prose, never a credential.
type SearchKnowledgeBaseOutput struct {
	// Result is the Markdown composition frames verbatim (ADR 0015).
	Result string `json:"result"`
	// NeedsLink is set when the caller has not linked the credential this
	// knowledge base's sources require. The turn then asks them to, rather than
	// answering from a corpus it could not check.
	NeedsLink bool `json:"needsLink,omitempty"`
	// LinkProviders are the providers the caller must link, when NeedsLink.
	LinkProviders []string `json:"linkProviders,omitempty"`
	// Citations is the probe-derived `Sources:` + "What this answer could not
	// see" disclosure block ALONE (corpus.CitationsBlock), carried out separately
	// so the workflow can DETERMINISTICALLY append it to whatever the turn finally
	// returns — even a Respond answer the planner recomposed in its own prose.
	// This closes the "finish vs respond" gap for KB citations/disclosure (ADR
	// 0040). Empty for the needs-link asks (nothing was searched).
	Citations string `json:"citations,omitempty"`
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
		renderInput := corpus.RenderInput{
			Withheld: withheld,
			Disclose: exec.DisclosePartialVisibility,
		}
		return SearchKnowledgeBaseOutput{
			Result:    corpus.Render(renderInput),
			Citations: corpus.CitationsBlock(renderInput),
		}, nil
	}

	tokens, err := a.Credentials.DelegatedTokens(ctx, in.Caller, providersOf(visible))
	if err != nil {
		return SearchKnowledgeBaseOutput{}, err
	}
	// Deterministic pre-search link gate (ADR 0040 §5): before spending a query,
	// report what the caller is missing so the workflow can stop and ask. Done
	// here, not in the planner's prose, because this is auth — it must happen
	// whether or not the model would have mentioned it.
	if in.GateOnly {
		return a.linkGate(ctx, in.Caller, exec.DisplayName, visible, tokens), nil
	}
	if len(tokens) == 0 {
		// Without the caller's own credential nothing can be probed, and probing
		// on the ingestion credential would answer a different question,
		// permissively (ADR 0040). Asking for a link is the only honest response.
		return a.needsLink(ctx, in.Caller, exec.DisplayName, providersToLink(visible, tokens)), nil
	}

	// Each member's connection must be probed with the token for ITS provider. A
	// member whose provider the caller has not linked is NOT probed on another
	// provider's token — that is the wrong question and silently drops results —
	// it becomes an honest "link this to see more" instead.
	var servable, notLinked []catalog.KnowledgeBaseExecMember
	tokenByConnection := make(map[string]string)
	principals := map[string]struct{}{}
	for _, member := range visible {
		provider := firstLinked(member.IdentityProviders, tokens)
		if provider == "" {
			notLinked = append(notLinked, member)
			continue
		}
		credential := tokens[provider]
		servable = append(servable, member)
		tokenByConnection[member.ID] = credential.Token
		for _, principal := range credential.Principals {
			principals[principal] = struct{}{}
		}
	}

	if len(servable) == 0 {
		return a.needsLink(ctx, in.Caller, exec.DisplayName, providersToLink(visible, tokens)), nil
	}

	stores, skipped, err := a.Corpora.Resolve(ctx, collectionsOf(servable))
	if err != nil {
		return SearchKnowledgeBaseOutput{}, err
	}

	outcome, err := corpus.Retrieve(ctx, stores, a.prober(tokenByConnection, servable), in.Query,
		in.Caller.Roles, sortedKeys(principals),
		knowledgeBaseLimit(in.Limit), corpus.DefaultCandidateMultiplier)
	if err != nil {
		return SearchKnowledgeBaseOutput{}, err
	}
	// Corpora it could not open and corpora that failed mid-query are the same
	// gap to the person reading the answer.
	outcome.SkippedCorpora += skipped

	// Members whose provider the caller has not linked: the served sources are
	// real, so this is a partial answer, not a block — but it still offers a
	// FRESH clickable link for each missing provider, so they can be linked one
	// at a time (e.g. Slack after Confluence and Drive), and a link that expired
	// before the caller finished is simply replaced on the next ask.
	unlinkedProviders := providersToLink(notLinked, tokens)
	renderInput := corpus.RenderInput{
		Outcome:  outcome,
		Withheld: withheld,
		Disclose: exec.DisclosePartialVisibility,
		Unlinked: &corpus.Unlinked{Providers: unlinkedProviders, Sources: len(notLinked)},
	}
	result := corpus.Render(renderInput)
	result = a.startLinks(ctx, in.Caller, unlinkedProviders, result)

	// Citations carried separately so the workflow appends it in code when the
	// planner recomposes via Respond (ADR 0040 survives finish/respond alike).
	return SearchKnowledgeBaseOutput{
		Result:        result,
		LinkProviders: unlinkedProviders,
		Citations:     corpus.CitationsBlock(renderInput),
	}, nil
}

// needsLink is the honest response when the caller has linked none of the
// providers a search needs — and, crucially, an ACTIONABLE one: it starts the
// OAuth flow for each and hands back a clickable link, not just a sentence
// naming them.
//
// Done here in the activity (not the workflow) because starting a flow is a
// network call and workflows must stay deterministic. PARITY: the TS graph's
// knowledgeBaseLinkPrompt (agent/graph.ts).
func (a *KnowledgeBaseActivities) needsLink(ctx context.Context, caller Caller, displayName string, providers []string) SearchKnowledgeBaseOutput {
	out := needsLinkAsk(displayName, providers)
	out.Result = a.startLinks(ctx, caller, providers, out.Result)
	return out
}

// needsLinkAsk is the plain "link your account" message, naming the providers.
func needsLinkAsk(displayName string, providers []string) SearchKnowledgeBaseOutput {
	which := ""
	if len(providers) > 0 {
		which = " (" + strings.Join(providers, ", ") + ")"
	}
	return SearchKnowledgeBaseOutput{
		NeedsLink:     true,
		LinkProviders: providers,
		Result: fmt.Sprintf(
			"I need you to link the account behind %s%s before I can search it — every result has to be "+
				"checked against your own access to the source.", displayName, which),
	}
}

// startLinks starts an authcode flow per provider and appends a clickable link
// to the ask. Authcode because atlassian/google/slack are redirect-based with
// nothing to poll — the caller links in the browser and asks again. Falls back
// to the plain message if no flow could be started (e.g. the gateway has the
// provider unconfigured, or no IdentityLinks was wired), so a misconfiguration
// degrades rather than failing the search.
func (a *KnowledgeBaseActivities) startLinks(ctx context.Context, caller Caller, providers []string, baseMessage string) string {
	clauses := a.linkClauses(ctx, caller, providers)
	if len(clauses) == 0 {
		return baseMessage
	}
	return baseMessage + "\n\n- " + strings.Join(clauses, "\n- ") +
		"\n\nOnce you've linked, ask again and I'll include those sources."
}

// linkClauses starts an authcode flow per provider and returns one rendered
// clickable clause each ("[link your slack account](url)"), skipping any whose
// flow could not be started. Authcode because atlassian/google/slack are
// redirect-based with nothing to poll. Empty when no IdentityLinks was wired or
// the gateway has every provider unconfigured, so a misconfiguration degrades
// to the plain message rather than failing the turn.
func (a *KnowledgeBaseActivities) linkClauses(ctx context.Context, caller Caller, providers []string) []string {
	if a.IdentityLinks == nil || len(providers) == 0 {
		return nil
	}
	var clauses []string
	for _, provider := range providers {
		// Start the link against the SAME subject the credential resolver looks
		// it up by, or the token would land under a key retrieval never reads.
		started, err := a.IdentityLinks.Start(ctx, provider, credentialSubject(caller, provider), identitylink.FlowAuthCode)
		if err != nil {
			continue
		}
		clauses = append(clauses, linkPrompt(started, provider))
	}
	return clauses
}

// linkGate is the deterministic pre-search check behind SearchKnowledgeBaseInput
// .GateOnly. It reports which of this knowledge base's providers the caller has
// NOT linked and renders the clickable ask, without running the search. An empty
// LinkProviders means nothing is missing and the caller should proceed.
func (a *KnowledgeBaseActivities) linkGate(
	ctx context.Context,
	caller Caller,
	displayName string,
	visible []catalog.KnowledgeBaseExecMember,
	tokens map[string]DelegatedCredential,
) SearchKnowledgeBaseOutput {
	unlinked := providersToLink(visible, tokens)
	if len(unlinked) == 0 {
		return SearchKnowledgeBaseOutput{}
	}
	linked := linkedProviders(visible, tokens)
	return SearchKnowledgeBaseOutput{
		Result:        a.gatePrompt(ctx, caller, displayName, linked, unlinked),
		LinkProviders: unlinked,
		NeedsLink:     len(linked) == 0,
	}
}

// gatePrompt is the deterministic interrupt shown before a search when the
// caller is missing one or more of a knowledge base's accounts. It names what
// is already linked, starts a flow for each missing provider and renders a
// clickable link, and tells the caller they can link and ask again — or ask
// again as-is to search with just what they have.
func (a *KnowledgeBaseActivities) gatePrompt(ctx context.Context, caller Caller, displayName string, linked, unlinked []string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Before I search the **%s** knowledge base, link the account(s) it covers "+
		"that you haven't yet (%s):", displayName, strings.Join(unlinked, ", "))

	if clauses := a.linkClauses(ctx, caller, unlinked); len(clauses) > 0 {
		b.WriteString("\n\n- " + strings.Join(clauses, "\n- "))
	}
	if len(linked) > 0 {
		fmt.Fprintf(&b, "\n\n(%s already linked.)", strings.Join(linked, ", "))
	}
	b.WriteString("\n\nLink the account(s) above and ask again, or ask again now to search with " +
		"just what you have linked.")
	return b.String()
}

// linkPrompt renders one started flow as a clickable clause. PARITY:
// authz.linkPromptText.
func linkPrompt(started identitylink.StartResult, label string) string {
	switch started.Flow {
	case identitylink.FlowDevice:
		return fmt.Sprintf("[link your %s account](%s) and enter code `%s`", label, started.VerificationURI, started.UserCode)
	case identitylink.FlowAuthCode:
		return fmt.Sprintf("[link your %s account](%s)", label, started.AuthorizeURL)
	default:
		return fmt.Sprintf("[link your %s account](%s)", label, started.PageURL)
	}
}

func (a *KnowledgeBaseActivities) prober(tokens map[string]string, members []catalog.KnowledgeBaseExecMember) corpus.Prober {
	granularities := make(map[string]corpus.Granularity, len(members))
	for _, member := range members {
		if member.Granularity == string(corpus.GranularityConnection) {
			granularities[member.ID] = corpus.GranularityConnection
			continue
		}
		granularities[member.ID] = corpus.GranularityResource
	}
	return &corpus.BrokerProber{
		BaseURL:         a.BrokerURL,
		Token:           a.BrokerToken,
		DelegatedTokens: tokens,
		Granularities:   granularities,
	}
}

// firstLinked returns the first of a member's identity providers the caller has
// linked, or "" when they have linked none of them — the member is then a
// "link this to see more" rather than probed on the wrong provider's token.
func firstLinked(providers []string, linked map[string]DelegatedCredential) string {
	for _, provider := range providers {
		if _, ok := linked[provider]; ok {
			return provider
		}
	}
	return ""
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
	return sortedKeys(set)
}

// providersToLink is the providers these members need that the caller has not
// linked, sorted — the set a "link this to see more" ask names.
func providersToLink(members []catalog.KnowledgeBaseExecMember, linked map[string]DelegatedCredential) []string {
	set := map[string]struct{}{}
	for _, member := range members {
		for _, provider := range member.IdentityProviders {
			if _, ok := linked[provider]; !ok {
				set[provider] = struct{}{}
			}
		}
	}
	return sortedKeys(set)
}

// linkedProviders is the providers these members need that the caller HAS
// linked, sorted — the "already linked" half of the gate prompt.
func linkedProviders(members []catalog.KnowledgeBaseExecMember, linked map[string]DelegatedCredential) []string {
	set := map[string]struct{}{}
	for _, member := range members {
		for _, provider := range member.IdentityProviders {
			if _, ok := linked[provider]; ok {
				set[provider] = struct{}{}
			}
		}
	}
	return sortedKeys(set)
}

// sortedKeys returns a set's members as a sorted slice, so a fan-out built from
// a map is deterministic rather than at the mercy of map iteration order.
func sortedKeys(set map[string]struct{}) []string {
	out := make([]string, 0, len(set))
	for key := range set {
		out = append(out, key)
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
