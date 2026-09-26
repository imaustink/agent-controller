package catalog_test

import (
	"context"
	"encoding/json"
	"sync"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// recordingStore captures what the indexer wrote, keyed by record id, so a test
// can assert on the shape of an upsert rather than on a Qdrant round trip.
type recordingStore struct {
	mu      sync.Mutex
	records map[string]vectorstore.Record
	deleted []string
}

func newRecordingStore() *recordingStore {
	return &recordingStore{records: map[string]vectorstore.Record{}}
}

func (s *recordingStore) Upsert(_ context.Context, records []vectorstore.Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, rec := range records {
		s.records[rec.ID] = rec
	}
	return nil
}

func (s *recordingStore) Delete(_ context.Context, ids []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, id := range ids {
		delete(s.records, id)
		s.deleted = append(s.deleted, id)
	}
	return nil
}

func (s *recordingStore) Query(context.Context, string, []string, int) ([]vectorstore.Hit, error) {
	return nil, nil
}
func (s *recordingStore) GetByIDs(context.Context, []string, []string) ([]vectorstore.Hit, error) {
	return nil, nil
}
func (s *recordingStore) GetByIDsUnfiltered(context.Context, []string) ([]vectorstore.Hit, error) {
	return nil, nil
}

func (s *recordingStore) get(id string) (vectorstore.Record, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rec, ok := s.records[id]
	return rec, ok
}

func (s *recordingStore) ids() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]string, 0, len(s.records))
	for id := range s.records {
		out = append(out, id)
	}
	return out
}

type indexerHarness struct {
	ix     *catalog.Indexer
	tools  *recordingStore
	skills *recordingStore
}

func newIndexerHarness() *indexerHarness {
	tools, skills, agents := newRecordingStore(), newRecordingStore(), newRecordingStore()
	return &indexerHarness{
		ix:     catalog.NewIndexer(vectorstore.Collections{Tools: tools, Skills: skills, Agents: agents}),
		tools:  tools,
		skills: skills,
	}
}

func confluenceConnectionDescriptor() catalog.CorpusDescriptor {
	return catalog.CorpusDescriptor{
		ID: "globex-confluence", Provider: "confluence", DisplayName: "GLOBEX Confluence",
		Description: "The GLOBEX space.", AllowedRoles: []string{"reader", "writer"},
		Collection: "conn_default_globex-confluence", APIEnabled: true,
		// A readable member: the read face has no service-credential mode, so a
		// corpus without this contributes no read tool (ADR 0040).
		IdentityProviders: []string{"atlassian"},
	}
}

func leadsConnectionDescriptor() catalog.CorpusDescriptor {
	return catalog.CorpusDescriptor{
		ID: "globex-slack-private", Provider: "slack", DisplayName: "#globex-leads",
		Description: "Leads-only channel.", AllowedRoles: []string{"lead"},
		Collection: "conn_default_globex-slack-private",
	}
}

func indexedKnowledgeBase() catalog.KnowledgeBaseDescriptor {
	return catalog.KnowledgeBaseDescriptor{
		ID: "globex", DisplayName: "GLOBEX", Description: "The GLOBEX engagement.",
		CorpusRefs:                []string{"globex-confluence", "globex-slack-private"},
		DisclosePartialVisibility: true,
	}
}

func decodeTool(t *testing.T, rec vectorstore.Record) catalog.ToolDescriptor {
	t.Helper()
	var tool catalog.ToolDescriptor
	require.NoError(t, json.Unmarshal(rec.Descriptor, &tool))
	return tool
}

func TestUpsertKnowledgeBaseIndexesASkillAndItsTools(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertCorpus(ctx, leadsConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	skill, ok := h.skills.get("kb:globex")
	require.True(t, ok, "the derived skill is what competes for the turn")
	require.False(t, skill.Hidden, "it is meant to be found")
	require.ElementsMatch(t, []string{"lead", "reader", "writer"}, skill.Roles)

	require.ElementsMatch(t, []string{
		"kb:globex/search", "kb:globex/read",
	}, h.tools.ids())
	require.NotContains(t, h.tools.ids(), "kb:globex/fetch",
		"fetch has no dispatch path, so no fetch tool is generated")
}

func TestGeneratedToolsAreHiddenFromOpenRetrieval(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	// Referenceable by the skill that declares them, never returned by open
	// retrieval — otherwise every client's scoped tooling competes in front of
	// every caller (ADR 0039 §2).
	for _, id := range []string{"kb:globex/search", "kb:globex/read"} {
		rec, ok := h.tools.get(id)
		require.True(t, ok, id)
		require.True(t, rec.Hidden, "%s must not be retrievable on its own", id)
	}
}

func TestReadToolIsUnionToInvokeAndPerMemberToRead(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertCorpus(ctx, leadsConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	read, ok := h.tools.get("kb:globex/read")
	require.True(t, ok)
	// Union to INVOKE, over the members this tool can actually SERVE. One tool
	// covers every readable member, so restricting it to any single member's
	// roles would make it uncallable for the rest — but the leads channel has
	// no API face, so a `lead`-only caller could read nothing through it, and
	// granting them invoke access would offer a tool that always refuses.
	//
	// Which member a caller may read is then checked per read, in the activity:
	// the same split search uses per point (ADR 0039 s4).
	require.ElementsMatch(t, []string{"reader", "writer"}, read.Roles)

	search, ok := h.tools.get("kb:globex/search")
	require.True(t, ok)
	require.ElementsMatch(t, []string{"lead", "reader", "writer"}, search.Roles)
}

func TestConnectionWithoutAnApiFaceContributesNoReadTool(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	conn := confluenceConnectionDescriptor()
	conn.APIEnabled = false
	require.NoError(t, h.ix.UpsertCorpus(ctx, conn))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	_, ok := h.tools.get("kb:globex/read")
	require.False(t, ok)
}

func TestTurningOffTheApiFaceRemovesTheReadTool(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	// The read tool belongs to the KNOWLEDGE BASE now, not to a member, so it
	// appears with the knowledge base rather than with the corpus.
	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))
	_, ok := h.tools.get("kb:globex/read")
	require.True(t, ok)

	off := confluenceConnectionDescriptor()
	off.APIEnabled = false
	require.NoError(t, h.ix.UpsertCorpus(ctx, off))
	require.NoError(t, h.ix.ReindexSkills(ctx))

	_, ok = h.tools.get("kb:globex/read")
	require.False(t, ok, "a withdrawn capability must not linger as a callable tool")
}

func TestDeleteKnowledgeBaseRemovesTheDerivedSkillByItsDerivedId(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))
	require.NoError(t, h.ix.DeleteKnowledgeBase(ctx, "globex"))

	// Deleting by CR name would leave `kb:globex` selectable, pointing at tools
	// that no longer exist.
	_, ok := h.skills.get("kb:globex")
	require.False(t, ok)

	_, ok = h.tools.get("kb:globex/search")
	require.False(t, ok)
	_, ok = h.tools.get("kb:globex/fetch")
	require.False(t, ok)
}

func TestDeleteConnectionLeavesTheKnowledgeBaseWorking(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertCorpus(ctx, leadsConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	require.NoError(t, h.ix.DeleteCorpus(ctx, "globex-confluence"))
	require.NoError(t, h.ix.ReindexSkills(ctx))

	// The only member that could serve a read is gone, so the read tool goes
	// with it rather than staying as an option that always fails.
	_, ok := h.tools.get("kb:globex/read")
	require.False(t, ok)

	// The knowledge base keeps answering over its remaining member: a vanished
	// connection is a dangling ref, which contributes nothing rather than
	// failing the whole skill closed.
	skill, ok := h.skills.get("kb:globex")
	require.True(t, ok)
	require.ElementsMatch(t, []string{"lead"}, skill.Roles)
}

func TestReindexRederivesKnowledgeBasesAgainstCurrentConnections(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	before, _ := h.skills.get("kb:globex")
	require.ElementsMatch(t, []string{"reader", "writer"}, before.Roles)

	// A member arriving after the knowledge base was indexed must widen it.
	require.NoError(t, h.ix.UpsertCorpus(ctx, leadsConnectionDescriptor()))
	require.NoError(t, h.ix.ReindexSkills(ctx))

	after, _ := h.skills.get("kb:globex")
	require.ElementsMatch(t, []string{"lead", "reader", "writer"}, after.Roles)
}

func TestGeneratedToolsCarryTheirExecutionSpec(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertCorpus(ctx, leadsConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	search := decodeTool(t, mustGet(t, h.tools, "kb:globex/search"))
	require.NotNil(t, search.KnowledgeBaseExec)
	require.Equal(t, "search", search.KnowledgeBaseExec.Operation)
	require.Equal(t, "globex", search.KnowledgeBaseExec.KnowledgeBaseID)

	// Membership is snapshotted at index time, so the executing side works from
	// exactly what the planner was offered.
	require.Len(t, search.KnowledgeBaseExec.Members, 2)
	byID := map[string]catalog.KnowledgeBaseExecMember{}
	for _, m := range search.KnowledgeBaseExec.Members {
		byID[m.ID] = m
	}
	require.Equal(t, "conn_default_globex-confluence", byID["globex-confluence"].Collection)
	require.Equal(t, []string{"reader", "writer"}, byID["globex-confluence"].AllowedRoles)

	// No fetch tool is generated: its whole-document read has no dispatch path
	// yet (ADR 0040 defers the source adapter), so the planner is never offered
	// a call that would silently degrade into a similarity search.
	_, ok := h.tools.get("kb:globex/fetch")
	require.False(t, ok)
}

func TestExecutionSpecRecordsEachProvidersProbeUnit(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertCorpus(ctx, leadsConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	search := decodeTool(t, mustGet(t, h.tools, "kb:globex/search"))
	byID := map[string]catalog.KnowledgeBaseExecMember{}
	for _, m := range search.KnowledgeBaseExec.Members {
		byID[m.ID] = m
	}

	// Slack authorizes a channel, so one probe settles every candidate from it.
	require.Equal(t, "connection", byID["globex-slack-private"].Granularity)
	// Confluence authorizes a page — the finer unit, and the safe default.
	require.Equal(t, "resource", byID["globex-confluence"].Granularity)
}

func TestExecutionSpecOmitsADanglingMember(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	search := decodeTool(t, mustGet(t, h.tools, "kb:globex/search"))
	require.Len(t, search.KnowledgeBaseExec.Members, 1,
		"a member that does not resolve contributes nothing to search either")
}

func TestGeneratedToolDescriptorsDescribeThemselves(t *testing.T) {
	h := newIndexerHarness()
	ctx := context.Background()

	require.NoError(t, h.ix.UpsertCorpus(ctx, confluenceConnectionDescriptor()))
	require.NoError(t, h.ix.UpsertKnowledgeBase(ctx, indexedKnowledgeBase()))

	search := decodeTool(t, mustGet(t, h.tools, "kb:globex/search"))
	require.Equal(t, "kb:globex/search", search.ID)
	require.Contains(t, search.Description, "GLOBEX")
	require.Contains(t, search.Output, "withheld")

	get := decodeTool(t, mustGet(t, h.tools, "kb:globex/read"))
	require.Contains(t, get.Input, "as the asking user")
}

func mustGet(t *testing.T, store *recordingStore, id string) vectorstore.Record {
	t.Helper()
	rec, ok := store.get(id)
	require.True(t, ok, "expected %s to be indexed", id)
	return rec
}
