package activities

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/controller-agent/temporal-engine/internal/catalog"
)

// ReadCorpusActivityName is the GET face a Corpus exposes (ADR 0038 §5).
const ReadCorpusActivityName = "ReadCorpus"

// ReadCorpusInput asks for the CURRENT state of one resource.
type ReadCorpusInput struct {
	Caller Caller `json:"caller"`
	// Tool carries the execution spec snapshotted at index time, so this runs
	// against exactly the corpus the planner was offered.
	Tool catalog.ToolDescriptor `json:"tool"`
	// SourceID is `<corpus>/<id>` — which member, and the resource id retrieval
	// cites. One tool serves the whole knowledge base, so the corpus travels
	// here rather than in the choice of tool.
	SourceID string `json:"sourceId"`
}

// ReadCorpusOutput carries prose and a citation, never a credential.
type ReadCorpusOutput struct {
	Result string `json:"result"`
	// NeedsLink is set when the caller has not linked the credential this read
	// requires — the turn asks rather than failing, and rather than silently
	// falling back to the ingestion credential, which would answer a different
	// question (ADR 0040).
	NeedsLink bool `json:"needsLink,omitempty"`
}

// ReadCorpus reads one resource live, as the calling user.
//
// This is the escape hatch retrieval needs and deliberately does not take on
// itself: an indexed chunk is a snapshot, and when the model decides the
// snapshot is not good enough it spends a call rather than every retrieval
// paying for hydration it may not need (ADR 0040).
//
// It takes an ID, never a path. An earlier version accepted a provider path
// and matched it against per-driver regexes, which answered the wrong
// question — "does this look like a page read" rather than "may this person
// read it" — and put pattern matching on model-supplied text at the centre of
// a security boundary.
//
// The bound is IDENTITY, not the corpus's scope. Material cites other spaces,
// and an agent that can read a page but not the page it references is not much
// use. Running as the caller means the source returns exactly what they would
// see by opening it themselves — no access they lack, just their own access
// used on their behalf. The scope check stays on the ingestion path, which has
// no user to be bounded by.
//
// The credential is resolved INSIDE the activity and never leaves it, for the
// reason AuthorizeActivities states: an activity result is persisted to
// workflow event history, so a token returned to the workflow would be durable
// plaintext for that history's whole retention.
func (a *KnowledgeBaseActivities) ReadCorpus(
	ctx context.Context,
	in ReadCorpusInput,
) (ReadCorpusOutput, error) {
	exec := in.Tool.KnowledgeBaseExec
	if exec == nil || exec.Operation != "read" {
		return ReadCorpusOutput{}, fmt.Errorf("tool %s is not a knowledge-base read", in.Tool.ID)
	}

	// `<corpus>/<id>`. Split on the FIRST separator only: a Slack id is itself
	// `<channel>/<ts>`, so anything after the corpus belongs to the source.
	corpusID, sourceID, ok := strings.Cut(in.SourceID, "/")
	if !ok || corpusID == "" || sourceID == "" {
		return ReadCorpusOutput{
			Result: fmt.Sprintf(
				"%q is not a readable reference. Use `<corpus>/<id>`, where <corpus> is one of: %s.",
				in.SourceID, memberNames(exec.Members)),
		}, nil
	}

	member, found := memberByID(exec.Members, corpusID)
	if !found {
		// Prose, not an error: the model named something outside this knowledge
		// base, which it can correct. Saying what IS available turns a dead end
		// into a usable next step.
		return ReadCorpusOutput{
			Result: fmt.Sprintf(
				"%q is not part of %s. Readable here: %s.",
				corpusID, exec.DisplayName, memberNames(exec.Members)),
		}, nil
	}

	// Union to INVOKE, per member to READ — the same split search uses per point
	// (ADR 0039 §4). The tool is callable by anyone who may reach any member,
	// because a tool nobody can call is useless; which member they may actually
	// read is checked here.
	//
	// This is OUR policy layer and it is not the same question as the source's.
	// A caller whose Atlassian account happens to see a page still may not reach
	// it through a corpus the operator scoped to other roles.
	if !holdsAnyRole(in.Caller.Roles, member.AllowedRoles) {
		return ReadCorpusOutput{
			Result: fmt.Sprintf("You do not have access to %s in this knowledge base.", member.Label),
		}, nil
	}

	credential, err := a.Credentials.DelegatedToken(ctx, in.Caller, member.IdentityProviders)
	if err != nil {
		return ReadCorpusOutput{}, err
	}
	if credential.Token == "" {
		return ReadCorpusOutput{
			NeedsLink: true,
			Result: fmt.Sprintf(
				"I need you to link the account behind %s before I can read from it — "+
					"a live read has to run as you, not as the ingestion credential.", member.Label),
		}, nil
	}

	body, citation, err := a.readThroughBroker(ctx, corpusID, sourceID, credential.Token)
	if err != nil {
		return ReadCorpusOutput{}, err
	}

	var out strings.Builder
	fmt.Fprintf(&out, "Live read from %s (%s)", member.Label, sourceID)
	if citation != "" {
		fmt.Fprintf(&out, " — %s", citation)
	}
	out.WriteString(":\n\n")
	out.WriteString(body)
	return ReadCorpusOutput{Result: out.String()}, nil
}

// readThroughBroker performs the GET, carrying the caller's own token.
//
// The orchestrator holds no third-party credential: it forwards one it did not
// mint and cannot widen, and the broker refuses to let it spend a corpus's
// service credential at all.
func (a *KnowledgeBaseActivities) readThroughBroker(
	ctx context.Context,
	corpus, sourceID, delegated string,
) (body string, citation string, err error) {
	endpoint := fmt.Sprintf("%s/corpora/%s/documents/%s",
		strings.TrimRight(a.BrokerURL, "/"), url.PathEscape(corpus), url.PathEscape(sourceID))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Authorization", "Bearer "+a.BrokerToken)
	req.Header.Set("x-delegated-token", delegated)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", "", fmt.Errorf("connection-broker unreachable: %w", err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", "", err
	}

	if res.StatusCode != http.StatusOK {
		// Returned as prose rather than as an error: a refused path or a
		// resource this user may not see is an ANSWER the model can act on —
		// it can try a different path, or say the material is not available —
		// where a failed activity just ends the turn.
		return fmt.Sprintf("The source refused that read (%d). %s",
			res.StatusCode, strings.TrimSpace(string(raw))), "", nil
	}

	// The fetch route returns a Document: the resource normalised to Markdown,
	// with the citation the source itself reported.
	var parsed struct {
		Markdown string `json:"markdown"`
		URL      string `json:"url"`
		Title    string `json:"title"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", "", fmt.Errorf("decode broker response: %w", err)
	}
	return parsed.Markdown, parsed.URL, nil
}

// memberByID finds the member a reference names.
func memberByID(members []catalog.KnowledgeBaseExecMember, id string) (catalog.KnowledgeBaseExecMember, bool) {
	for _, member := range members {
		if member.ID == id {
			return member, true
		}
	}
	return catalog.KnowledgeBaseExecMember{}, false
}

// memberNames lists what the model may name, so a refusal is actionable rather
// than a dead end.
func memberNames(members []catalog.KnowledgeBaseExecMember) string {
	names := make([]string, 0, len(members))
	for _, member := range members {
		names = append(names, fmt.Sprintf("%s (%s)", member.ID, member.Label))
	}
	if len(names) == 0 {
		return "nothing — this knowledge base has no readable members"
	}
	return strings.Join(names, ", ")
}

// holdsAnyRole is the match-any rule the vector store applies to a point.
//
// Empty caller roles match NOTHING, which is the fail-closed default: an
// unresolved identity is not a permissive one.
func holdsAnyRole(caller, required []string) bool {
	if len(caller) == 0 || len(required) == 0 {
		return false
	}
	held := make(map[string]struct{}, len(caller))
	for _, role := range caller {
		held[role] = struct{}{}
	}
	for _, role := range required {
		if _, ok := held[role]; ok {
			return true
		}
	}
	return false
}
