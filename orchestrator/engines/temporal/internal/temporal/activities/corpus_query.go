package activities

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/corpus"
)

// QueryCorpusActivityName is the LIVE structured query face a knowledge base
// exposes.
const QueryCorpusActivityName = "QueryCorpus"

const (
	defaultQueryLimit = 10
	maxQueryLimit     = 25
)

// QueryCorpusInput asks the sources a structured question about their items.
type QueryCorpusInput struct {
	Caller Caller `json:"caller"`
	// Tool carries the execution spec snapshotted at index time, so this runs
	// against exactly the corpora the planner was offered.
	Tool catalog.ToolDescriptor `json:"tool"`
	// Query is the planner's tool input: a JSON object of filters (see
	// SourceQuery), or plain words, which mean {"text": <words>}.
	Query string `json:"query"`
	// FirstIndex is the citation number the first item takes: the turn's next
	// unused number, shared with search and read. Zero means 1.
	FirstIndex int `json:"firstIndex,omitempty"`
}

// QueryCorpusOutput carries prose and citations, never a credential.
type QueryCorpusOutput struct {
	Result string `json:"result"`
	// NeedsLink is set when NO member could be asked for want of a linked
	// account, so the turn can ask instead of reporting an empty result.
	NeedsLink bool `json:"needsLink,omitempty"`
	// LinkProviders are the providers to link when NeedsLink.
	LinkProviders []string `json:"linkProviders,omitempty"`
	// Sources are the items, numbered from FirstIndex, so an answer can cite them
	// inline. Each title and URL is the source's own answer to a request run AS
	// the caller, so it is theirs to see, like a probe's.
	Sources []corpus.Source `json:"sources,omitempty"`
}

// SourceQuery is the provider-neutral filter the broker translates into each
// source's own query language (Slack search modifiers, Confluence CQL, Drive
// `q`). PARITY: SourceQuery in orchestrator/apps/connection-broker/src/drivers/types.ts.
type SourceQuery struct {
	Text   string `json:"text,omitempty"`
	Title  string `json:"title,omitempty"`
	Author string `json:"author,omitempty"`
	After  string `json:"after,omitempty"`
	Before string `json:"before,omitempty"`
	Type   string `json:"type,omitempty"`
	Sort   string `json:"sort,omitempty"`
	Limit  int    `json:"limit,omitempty"`
}

// plannerQuery is what the planner writes: a SourceQuery plus which source.
type plannerQuery struct {
	Source string `json:"source"`
	SourceQuery
}

// QueryCorpus answers a structured question about the sources' items, LIVE and
// as the calling user: filter by keywords, title, author, date range and type;
// sort newest, oldest or by relevance; optionally in one source.
//
// Live for the reasons the index cannot serve these: it ranks by relevance only,
// its metadata is not queryable, and it lags by a sync interval. Each source
// applies the filter in its own query language (the broker's job) and refuses a
// filter it cannot apply rather than silently ignoring it — those refusals are
// reported, never presented as matches.
//
// Bounded the way the other live faces are: our role policy per member, then
// the source's own answer to the caller's token, inside the corpus's scope.
//
// PARITY: CorpusQuery in orchestrator/apps/agent-orchestrator/src/knowledge-base/query.ts.
func (a *KnowledgeBaseActivities) QueryCorpus(
	ctx context.Context,
	in QueryCorpusInput,
) (QueryCorpusOutput, error) {
	exec := in.Tool.KnowledgeBaseExec
	if exec == nil || exec.Operation != "query" {
		return QueryCorpusOutput{}, fmt.Errorf("tool %s is not a knowledge-base query", in.Tool.ID)
	}

	q, problem := parsePlannerQuery(in.Query)
	if problem != "" {
		// Prose, not an error: the planner wrote the input and can correct it.
		return QueryCorpusOutput{Result: problem}, nil
	}

	members, matched := membersNamed(exec.Members, q.Source)
	if !matched {
		return QueryCorpusOutput{Result: fmt.Sprintf(
			"%q is not a source in %s. Sources here: %s.",
			q.Source, exec.DisplayName, memberNames(exec.Members))}, nil
	}

	var (
		perSource     [][]queryItem
		unlinked      []string
		unlinkedProvs = map[string]struct{}{}
		refused       []string
		asked         int
		anyMember     bool
	)
	for _, member := range members {
		if !holdsAnyRole(in.Caller.Roles, member.AllowedRoles) {
			continue
		}
		anyMember = true

		credential, err := a.Credentials.DelegatedToken(ctx, in.Caller, member.IdentityProviders)
		if err != nil {
			return QueryCorpusOutput{}, err
		}
		if credential.Token == "" {
			unlinked = append(unlinked, member.Label)
			for _, p := range member.IdentityProviders {
				unlinkedProvs[p] = struct{}{}
			}
			continue
		}

		found, note, err := a.queryThroughBroker(ctx, member.ID, q.SourceQuery, credential.Token)
		if err != nil {
			return QueryCorpusOutput{}, err
		}
		if note != "" {
			refused = append(refused, fmt.Sprintf("%s (%s)", member.Label, note))
			continue
		}
		asked++
		for i := range found {
			found[i].member = member.Label
			found[i].corpus = member.ID
		}
		perSource = append(perSource, found)
	}

	if !anyMember {
		return QueryCorpusOutput{
			Result: fmt.Sprintf("You do not have access to anything in %s.", exec.DisplayName),
		}, nil
	}

	// Only ask for a link when nothing could be asked at all, as search does.
	if asked == 0 && len(unlinked) > 0 {
		providers := sortedKeys(unlinkedProvs)
		base := fmt.Sprintf(
			"I need you to link the account behind %s before I can query it — "+
				"this runs as you, not as the ingestion credential.",
			strings.Join(unlinked, ", "))
		return QueryCorpusOutput{
			NeedsLink:     true,
			LinkProviders: providers,
			Result:        a.startLinks(ctx, in.Caller, providers, base),
		}, nil
	}

	items := mergeQueryResults(perSource, q.Sort, q.Limit)
	first := in.FirstIndex
	if first < 1 {
		first = 1
	}
	sources := make([]corpus.Source, 0, len(items))
	for i, item := range items {
		sources = append(sources, corpus.Source{N: first + i, Title: item.Title, URL: item.URL})
	}
	return QueryCorpusOutput{
		Result:  renderQuery(exec.DisplayName, q, first, items, unlinked, refused),
		Sources: sources,
	}, nil
}

// parsePlannerQuery reads the planner's input, applies the defaults, and
// validates it, returning prose the planner can act on when it is not usable.
//
// Plain words, not JSON, are taken as keywords: a planner that writes `retro`
// rather than {"text":"retro"} still gets the keyword query it meant.
func parsePlannerQuery(raw string) (plannerQuery, string) {
	var q plannerQuery
	trimmed := strings.TrimSpace(raw)
	if strings.HasPrefix(trimmed, "{") {
		dec := json.NewDecoder(strings.NewReader(trimmed))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&q); err != nil {
			return q, fmt.Sprintf("That query is not usable (%v). Send a JSON object with any of: "+
				"source, text, title, author, after, before, type, sort, limit.", err)
		}
	} else {
		q.Text = trimmed
	}

	for name, date := range map[string]string{"after": q.After, "before": q.Before} {
		if date == "" {
			continue
		}
		if _, err := time.Parse("2006-01-02", date); err != nil {
			return q, fmt.Sprintf("%q is not a date for %q; use YYYY-MM-DD.", date, name)
		}
	}
	switch q.Sort {
	case "":
		if q.Text != "" {
			q.Sort = "relevance"
		} else {
			q.Sort = "newest"
		}
	case "relevance", "newest", "oldest":
		if q.Sort == "relevance" && q.Text == "" {
			q.Sort = "newest" // nothing to be relevant to
		}
	default:
		return q, fmt.Sprintf("%q is not a sort; use newest, oldest or relevance.", q.Sort)
	}
	switch {
	case q.Limit < 0:
		return q, "limit must be positive."
	case q.Limit == 0:
		q.Limit = defaultQueryLimit
	case q.Limit > maxQueryLimit:
		q.Limit = maxQueryLimit
	}
	return q, ""
}

// queryItem is one item, plus which member produced it.
type queryItem struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	URL       string `json:"url"`
	UpdatedAt string `json:"updatedAt"`
	Excerpt   string `json:"excerpt"`

	member string
	corpus string
}

// membersNamed narrows to the member a caller named, by id or display name,
// ignoring case and a leading "#". An empty name is every member. matched is
// false when a name was given and nothing answers to it — said, not silently
// widened to everything.
func membersNamed(members []catalog.KnowledgeBaseExecMember, name string) ([]catalog.KnowledgeBaseExecMember, bool) {
	want := normalizeSourceName(name)
	if want == "" {
		return members, true
	}
	for _, member := range members {
		if normalizeSourceName(member.ID) == want || normalizeSourceName(member.Label) == want {
			return []catalog.KnowledgeBaseExecMember{member}, true
		}
	}
	return nil, false
}

func normalizeSourceName(s string) string {
	return strings.TrimPrefix(strings.ToLower(strings.TrimSpace(s)), "#")
}

// mergeQueryResults combines each source's results into one list of at most
// limit.
//
// Time sorts merge on each item's own clock. Relevance cannot: one provider's
// score means nothing next to another's, so sources are interleaved in turn,
// keeping each source's own ranking. An item whose time cannot be parsed sorts
// last rather than being dropped — it is still something the source returned.
func mergeQueryResults(perSource [][]queryItem, order string, limit int) []queryItem {
	var merged []queryItem
	if order == "relevance" {
		for i := 0; ; i++ {
			added := false
			for _, items := range perSource {
				if i < len(items) {
					merged = append(merged, items[i])
					added = true
				}
			}
			if !added {
				break
			}
		}
	} else {
		for _, items := range perSource {
			merged = append(merged, items...)
		}
		parsed := func(s string) (time.Time, bool) {
			t, err := time.Parse(time.RFC3339Nano, s)
			return t, err == nil
		}
		sort.SliceStable(merged, func(i, j int) bool {
			ti, oki := parsed(merged[i].UpdatedAt)
			tj, okj := parsed(merged[j].UpdatedAt)
			if oki != okj {
				return oki
			}
			if order == "oldest" {
				return ti.Before(tj)
			}
			return ti.After(tj)
		})
	}
	if len(merged) > limit {
		merged = merged[:limit]
	}
	return merged
}

// describeQuery is the filter in words, so the result says what it answered.
func describeQuery(q plannerQuery) string {
	var parts []string
	add := func(label, value string) {
		if value != "" {
			parts = append(parts, fmt.Sprintf("%s %q", label, value))
		}
	}
	add("matching", q.Text)
	add("titled", q.Title)
	add("by", q.Author)
	add("type", q.Type)
	add("changed on or after", q.After)
	add("changed before", q.Before)
	if q.Sort == "relevance" {
		parts = append(parts, "most relevant first")
	} else {
		parts = append(parts, q.Sort+" first")
	}
	return strings.Join(parts, ", ")
}

// renderQuery turns items into something a model can act on: each with its
// citation marker, when it changed, and a reference the read tool takes.
func renderQuery(displayName string, q plannerQuery, firstIndex int, items []queryItem, unlinked, refused []string) string {
	var out strings.Builder

	where := displayName
	if strings.TrimSpace(q.Source) != "" {
		where = fmt.Sprintf("%s (%s)", displayName, strings.TrimSpace(q.Source))
	}
	if len(items) == 0 {
		fmt.Fprintf(&out, "Nothing in %s matches: %s.", where, describeQuery(q))
	} else {
		fmt.Fprintf(&out, "Results from %s — %s:\n", where, describeQuery(q))
		for i, item := range items {
			fmt.Fprintf(&out, "\n- [%d] %s — %s", firstIndex+i, item.Title, item.member)
			if item.UpdatedAt != "" {
				fmt.Fprintf(&out, " · changed %s", item.UpdatedAt)
			}
			fmt.Fprintf(&out, "\n  reference: %s/%s", item.corpus, item.ID)
			if item.URL != "" {
				fmt.Fprintf(&out, "\n  %s", item.URL)
			}
			if item.Excerpt != "" {
				fmt.Fprintf(&out, "\n  %s", strings.Join(strings.Fields(item.Excerpt), " "))
			}
		}
	}

	// Stated rather than swallowed: a result the caller believes is complete,
	// missing a source, is worse than one that says what it skipped.
	if len(unlinked) > 0 {
		fmt.Fprintf(&out, "\n\nNot queried (no linked account): %s.", strings.Join(unlinked, ", "))
	}
	if len(refused) > 0 {
		fmt.Fprintf(&out, "\n\nCould not query: %s.", strings.Join(refused, "; "))
	}
	return out.String()
}

// queryThroughBroker runs the filter against one corpus, carrying the caller's
// own token. A refusal — the source cannot apply a filter, cannot be queried,
// or declined — comes back as a note, not an error, so the other members still
// answer.
func (a *KnowledgeBaseActivities) queryThroughBroker(
	ctx context.Context,
	corpusID string,
	q SourceQuery,
	delegated string,
) (items []queryItem, note string, err error) {
	body, err := json.Marshal(q)
	if err != nil {
		return nil, "", err
	}
	endpoint := fmt.Sprintf("%s/corpora/%s/query", strings.TrimRight(a.BrokerURL, "/"), url.PathEscape(corpusID))

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("Authorization", "Bearer "+a.BrokerToken)
	req.Header.Set("Content-Type", "application/json")
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
		return nil, "cannot be queried this way", nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, refusalNote(res.StatusCode, raw), nil
	}

	var parsed struct {
		Hits        []queryItem `json:"hits"`
		Unsupported []string    `json:"unsupported"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "", fmt.Errorf("decode broker response: %w", err)
	}
	if len(parsed.Unsupported) > 0 {
		// Refused, not ignored: these results would not be what was asked for.
		return nil, "cannot filter by " + strings.Join(parsed.Unsupported, ", "), nil
	}
	return parsed.Hits, "", nil
}
