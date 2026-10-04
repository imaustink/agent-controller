package activities

import (
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

// RecentCorpusActivityName is the LIVE "newest first" face a knowledge base
// exposes.
const RecentCorpusActivityName = "RecentCorpus"

// recentLimit is how many items a recent call returns across all sources.
const recentLimit = 10

// RecentCorpusInput asks the sources for their most recently changed items.
type RecentCorpusInput struct {
	Caller Caller `json:"caller"`
	// Tool carries the execution spec snapshotted at index time, so this runs
	// against exactly the corpora the planner was offered.
	Tool catalog.ToolDescriptor `json:"tool"`
	// Source optionally narrows to one member, by id or display name ("#team-snc"
	// and "team-snc" both match). Empty means every member.
	Source string `json:"source,omitempty"`
	// FirstIndex is the citation number the first item takes: the turn's next
	// unused number, shared with search and lookup. Zero means 1.
	FirstIndex int `json:"firstIndex,omitempty"`
}

// RecentCorpusOutput carries prose and citations, never a credential.
type RecentCorpusOutput struct {
	Result string `json:"result"`
	// NeedsLink is set when NO member could be asked for want of a linked
	// account, so the turn can ask instead of reporting an empty list.
	NeedsLink bool `json:"needsLink,omitempty"`
	// LinkProviders are the providers to link when NeedsLink.
	LinkProviders []string `json:"linkProviders,omitempty"`
	// Sources are the items, numbered from FirstIndex, so an answer can cite them
	// inline. Each title and URL is the source's own answer to a request run AS
	// the caller, so it is theirs to see, like a probe's.
	Sources []corpus.Source `json:"sources,omitempty"`
}

// RecentCorpus lists the sources' newest items, LIVE and as the calling user.
//
// The recency counterpart of LookupCorpus, and live for the same reason: "what
// is the latest message in #team-snc" is a question about NOW, which the index
// cannot answer — it ranks by relevance, not time, and lags by a sync interval.
// Each source orders by its own clock (Slack timestamp, Confluence last-modified,
// Drive modifiedTime) and this merges them newest first.
//
// Bounded the way lookup is: our role policy per member, then the source's own
// answer to the caller's token, inside the corpus's scope (the broker's job).
//
// PARITY: CorpusRecent in apps/agent-orchestrator/src/knowledge-base/recent.ts.
func (a *KnowledgeBaseActivities) RecentCorpus(
	ctx context.Context,
	in RecentCorpusInput,
) (RecentCorpusOutput, error) {
	exec := in.Tool.KnowledgeBaseExec
	if exec == nil || exec.Operation != "recent" {
		return RecentCorpusOutput{}, fmt.Errorf("tool %s is not a knowledge-base recent", in.Tool.ID)
	}

	members, matched := membersNamed(exec.Members, in.Source)
	if !matched {
		return RecentCorpusOutput{Result: fmt.Sprintf(
			"%q is not a source in %s. Sources here: %s.",
			in.Source, exec.DisplayName, memberNames(exec.Members))}, nil
	}

	var (
		items         []recentItem
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
			return RecentCorpusOutput{}, err
		}
		if credential.Token == "" {
			unlinked = append(unlinked, member.Label)
			for _, p := range member.IdentityProviders {
				unlinkedProvs[p] = struct{}{}
			}
			continue
		}

		found, note, err := a.recentThroughBroker(ctx, member.ID, credential.Token)
		if err != nil {
			return RecentCorpusOutput{}, err
		}
		if note != "" {
			refused = append(refused, fmt.Sprintf("%s (%s)", member.Label, note))
			continue
		}
		asked++
		for _, item := range found {
			item.member = member.Label
			item.corpus = member.ID
			items = append(items, item)
		}
	}

	if !anyMember {
		return RecentCorpusOutput{
			Result: fmt.Sprintf("You do not have access to anything in %s.", exec.DisplayName),
		}, nil
	}

	// Only ask for a link when nothing could be asked at all, as lookup does.
	if asked == 0 && len(unlinked) > 0 {
		providers := sortedKeys(unlinkedProvs)
		base := fmt.Sprintf(
			"I need you to link the account behind %s before I can check what is new — "+
				"this runs as you, not as the ingestion credential.",
			strings.Join(unlinked, ", "))
		return RecentCorpusOutput{
			NeedsLink:     true,
			LinkProviders: providers,
			Result:        a.startLinks(ctx, in.Caller, providers, base),
		}, nil
	}

	items = newestFirst(items, recentLimit)
	first := in.FirstIndex
	if first < 1 {
		first = 1
	}
	sources := make([]corpus.Source, 0, len(items))
	for i, item := range items {
		sources = append(sources, corpus.Source{N: first + i, Title: item.Title, URL: item.URL})
	}
	return RecentCorpusOutput{
		Result:  renderRecent(exec.DisplayName, in.Source, first, items, unlinked, refused),
		Sources: sources,
	}, nil
}

// recentItem is one item, plus which member produced it.
type recentItem struct {
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

// newestFirst orders items by when they changed, newest first, and keeps at
// most limit. An item whose time cannot be parsed sorts last rather than being
// dropped: it is still something the source returned.
func newestFirst(items []recentItem, limit int) []recentItem {
	parsed := func(s string) (time.Time, bool) {
		t, err := time.Parse(time.RFC3339Nano, s)
		return t, err == nil
	}
	sort.SliceStable(items, func(i, j int) bool {
		ti, oki := parsed(items[i].UpdatedAt)
		tj, okj := parsed(items[j].UpdatedAt)
		if oki != okj {
			return oki
		}
		return ti.After(tj)
	})
	if len(items) > limit {
		items = items[:limit]
	}
	return items
}

// renderRecent turns items into something a model can act on: each with its
// citation marker, when it changed, and a reference the read tool takes.
func renderRecent(displayName, source string, firstIndex int, items []recentItem, unlinked, refused []string) string {
	var out strings.Builder

	where := displayName
	if strings.TrimSpace(source) != "" {
		where = fmt.Sprintf("%s (%s)", displayName, strings.TrimSpace(source))
	}
	if len(items) == 0 {
		fmt.Fprintf(&out, "Nothing recent came back from %s.", where)
	} else {
		fmt.Fprintf(&out, "Most recent in %s, newest first:\n", where)
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

	// Stated rather than swallowed, as lookup does: a list the caller believes is
	// complete, missing a source, is worse than one that says what it skipped.
	if len(unlinked) > 0 {
		fmt.Fprintf(&out, "\n\nNot checked (no linked account): %s.", strings.Join(unlinked, ", "))
	}
	if len(refused) > 0 {
		fmt.Fprintf(&out, "\n\nCould not check: %s.", strings.Join(refused, ", "))
	}
	return out.String()
}

// recentThroughBroker asks the broker for one corpus's newest items, carrying
// the caller's own token. A refusal comes back as a note, not an error, so the
// other members still answer.
func (a *KnowledgeBaseActivities) recentThroughBroker(
	ctx context.Context,
	corpusID, delegated string,
) (items []recentItem, note string, err error) {
	endpoint := fmt.Sprintf("%s/corpora/%s/recent?limit=%d",
		strings.TrimRight(a.BrokerURL, "/"), url.PathEscape(corpusID), recentLimit)

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
		// This provider cannot list by time. Not an error: that source simply
		// contributes nothing here.
		return nil, "cannot list recent items", nil
	}
	if res.StatusCode != http.StatusOK {
		return nil, refusalNote(res.StatusCode, raw), nil
	}

	var parsed struct {
		Hits []recentItem `json:"hits"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, "", fmt.Errorf("decode broker response: %w", err)
	}
	return parsed.Hits, "", nil
}
