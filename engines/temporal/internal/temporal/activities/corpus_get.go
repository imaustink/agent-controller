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
	// SourceID is the id of a resource in this corpus — the same id retrieval
	// cites, so the model asks for something it has seen rather than composing
	// a provider path.
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
// question — "does this look like a page read" rather than "is this in the
// corpus" — and put pattern matching on model-supplied text at the centre of
// a security boundary. An id goes straight to the driver's existing fetch,
// which already refuses anything outside the corpus's scope, and the read runs
// on the caller's own token so the source applies their permissions too.
//
// The credential is resolved INSIDE the activity and never leaves it, for the
// reason AuthorizeActivities states: an activity result is persisted to
// workflow event history, so a token returned to the workflow would be durable
// plaintext for that history's whole retention.
func (a *KnowledgeBaseActivities) ReadCorpus(
	ctx context.Context,
	in ReadCorpusInput,
) (ReadCorpusOutput, error) {
	exec := in.Tool.CorpusGetExec
	if exec == nil {
		return ReadCorpusOutput{}, fmt.Errorf("tool %s carries no corpus GET spec", in.Tool.ID)
	}

	credential, err := a.Credentials.DelegatedToken(ctx, in.Caller, exec.IdentityProviders)
	if err != nil {
		return ReadCorpusOutput{}, err
	}
	if credential.Token == "" {
		return ReadCorpusOutput{
			NeedsLink: true,
			Result: fmt.Sprintf(
				"I need you to link the account behind %s before I can read from it — "+
					"a live read has to run as you, not as the ingestion credential.", exec.Label),
		}, nil
	}

	body, citation, err := a.readThroughBroker(ctx, exec.CorpusID, in.SourceID, credential.Token)
	if err != nil {
		return ReadCorpusOutput{}, err
	}

	var out strings.Builder
	fmt.Fprintf(&out, "Live read from %s (%s)", exec.Label, in.SourceID)
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
	endpoint := fmt.Sprintf("%s/corpora/%s/resources/%s",
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
