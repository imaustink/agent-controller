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

// LookupCorpusActivityName is the LIVE search face a knowledge base exposes.
const LookupCorpusActivityName = "LookupCorpus"

// LookupCorpusInput asks the sources themselves, rather than the index.
type LookupCorpusInput struct {
	Caller Caller `json:"caller"`
	// Tool carries the execution spec snapshotted at index time, so this runs
	// against exactly the corpora the planner was offered.
	Tool catalog.ToolDescriptor `json:"tool"`
	// Query is the caller's words, passed to each provider's own search.
	Query string `json:"query"`
}

// LookupCorpusOutput carries prose and citations, never a credential.
type LookupCorpusOutput struct {
	Result string `json:"result"`
	// NeedsLink is set when NO member could be searched for want of a linked
	// account, so the turn can ask instead of reporting an empty result that
	// looks like "nothing found".
	NeedsLink bool `json:"needsLink,omitempty"`
}

// LookupCorpus searches the SOURCES live, as the calling user.
//
// The complement to SearchKnowledgeBase rather than a replacement for it. The
// index answers "what do we know about X" over a snapshot and is fast, ranked
// and semantic; this answers "what is there NOW", which a stale snapshot
// cannot, and is lexical because that is what the providers offer. A page
// written this morning is invisible to the first and findable by the second.
//
// Bounded BOTH ways: by the corpus's scope and by who is asking. That is the
// deliberate asymmetry with ReadCorpus, which is bounded by identity alone —
// a read follows a citation the caller is already looking at, so leaving the
// scope behind lets an agent follow a link out of the indexed space. A search
// has no such anchor, and an unbounded one would turn "what does this
// knowledge base know" into "everything this person can see anywhere". The
// scope half is enforced by the broker and, under it, by each driver.
//
// Fans out across members because a knowledge base is a composition: the
// question is asked of the whole thing, and which source answers it is not
// something the caller should have to know.
func (a *KnowledgeBaseActivities) LookupCorpus(
	ctx context.Context,
	in LookupCorpusInput,
) (LookupCorpusOutput, error) {
	exec := in.Tool.KnowledgeBaseExec
	if exec == nil || exec.Operation != "lookup" {
		return LookupCorpusOutput{}, fmt.Errorf("tool %s is not a knowledge-base lookup", in.Tool.ID)
	}

	query := strings.TrimSpace(in.Query)
	if query == "" {
		return LookupCorpusOutput{
			Result: "Give me something to look for — this searches the sources for words you name.",
		}, nil
	}

	// Union to INVOKE, per member to SEARCH: the same split ReadCorpus uses,
	// and the same reason. `allowedRoles` is OUR policy layer, so a caller
	// whose Atlassian account can see a space may still not reach it through a
	// corpus the operator scoped to other roles.
	var (
		hits      []lookupHit
		unlinked  []string
		refused   []string
		searched  int
		anyMember bool
	)
	for _, member := range exec.Members {
		if !holdsAnyRole(in.Caller.Roles, member.AllowedRoles) {
			continue
		}
		anyMember = true

		credential, err := a.Credentials.DelegatedToken(ctx, in.Caller, member.IdentityProviders)
		if err != nil {
			return LookupCorpusOutput{}, err
		}
		if credential.Token == "" {
			unlinked = append(unlinked, member.Label)
			continue
		}

		found, note, err := a.lookupThroughBroker(ctx, member.ID, query, credential.Token)
		if err != nil {
			return LookupCorpusOutput{}, err
		}
		if note != "" {
			// A source that refused or has no live search is reported, not
			// fatal: the other members still have answers, and silently
			// dropping one would make the result look complete when it is not.
			refused = append(refused, fmt.Sprintf("%s (%s)", member.Label, note))
			continue
		}
		searched++
		for _, hit := range found {
			hit.member = member.Label
			hit.corpus = member.ID
			hits = append(hits, hit)
		}
	}

	if !anyMember {
		return LookupCorpusOutput{
			Result: fmt.Sprintf("You do not have access to anything in %s.", exec.DisplayName),
		}, nil
	}

	// Only ask for a link when nothing could be searched at all. Asking while
	// two of three members answered would interrupt a turn that succeeded.
	if searched == 0 && len(unlinked) > 0 {
		return LookupCorpusOutput{
			NeedsLink: true,
			Result: fmt.Sprintf(
				"I need you to link the account behind %s before I can search it live — "+
					"this runs as you, not as the ingestion credential.",
				strings.Join(unlinked, ", ")),
		}, nil
	}

	return LookupCorpusOutput{Result: renderLookup(exec.DisplayName, query, hits, unlinked, refused)}, nil
}

// lookupHit is one result, plus which member produced it.
type lookupHit struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	URL     string `json:"url"`
	Excerpt string `json:"excerpt"`

	member string
	corpus string
}

// renderLookup turns hits into something a model can act on.
//
// Every hit is printed with `<corpus>/<id>`, which is exactly what the read
// tool takes. That is the point of the pairing: a lookup finds the current
// document and hands back a reference that reads it, without the model having
// to assemble one.
func renderLookup(displayName, query string, hits []lookupHit, unlinked, refused []string) string {
	var out strings.Builder

	if len(hits) == 0 {
		fmt.Fprintf(&out, "Nothing in %s matches %q right now.", displayName, query)
	} else {
		fmt.Fprintf(&out, "Live results from %s for %q:\n", displayName, query)
		for _, hit := range hits {
			fmt.Fprintf(&out, "\n- %s — %s\n  reference: %s/%s", hit.Title, hit.member, hit.corpus, hit.ID)
			if hit.URL != "" {
				fmt.Fprintf(&out, "\n  %s", hit.URL)
			}
			if hit.Excerpt != "" {
				fmt.Fprintf(&out, "\n  %s", strings.Join(strings.Fields(hit.Excerpt), " "))
			}
		}
	}

	// Stated rather than swallowed: a partial answer the caller believes is
	// complete is worse than one that says what it could not reach.
	if len(unlinked) > 0 {
		fmt.Fprintf(&out, "\n\nNot searched (no linked account): %s.", strings.Join(unlinked, ", "))
	}
	if len(refused) > 0 {
		fmt.Fprintf(&out, "\n\nCould not search: %s.", strings.Join(refused, ", "))
	}
	return out.String()
}

// lookupThroughBroker performs the search, carrying the caller's own token.
//
// Returns a non-empty note instead of an error when the source answered with a
// refusal: like a refused read, that is an ANSWER the model can act on, where
// a failed activity just ends the turn.
func (a *KnowledgeBaseActivities) lookupThroughBroker(
	ctx context.Context,
	corpus, query, delegated string,
) (hits []lookupHit, note string, err error) {
	endpoint := fmt.Sprintf("%s/corpora/%s/search?q=%s",
		strings.TrimRight(a.BrokerURL, "/"), url.PathEscape(corpus), url.QueryEscape(query))

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+a.BrokerToken)
	req.Header.Set("x-delegated-token", delegated)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, "", fmt.Errorf("connection-broker unreachable: %w", err)
	}
	defer res.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, "", err
	}

	if res.StatusCode == http.StatusNotFound {
		// This provider has no live search — Slack without `search:read`, or a
		// driver that never implemented it. Not an error: that corpus simply
		// contributes nothing here and keeps its indexed passages.
		return nil, "no live search for this source", nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Sprintf("refused (%d)", res.StatusCode), nil
	}

	var parsed struct {
		Hits []lookupHit `json:"hits"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "", fmt.Errorf("decode broker response: %w", err)
	}
	return parsed.Hits, "", nil
}
