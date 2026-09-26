package catalog

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// Indexing a KnowledgeBase produces records in TWO collections, and they are
// visible in opposite ways.
//
//   - The derived skill goes into `skills` and is meant to be found: it is what
//     competes for the turn (ADR 0039 §2).
//   - Its tools go into `tools` HIDDEN: referenceable by the skill that declares
//     them, never returned by open retrieval. Twenty clients' scoped search and
//     GET tools competing in the global catalog is exactly the outcome that
//     design avoids.

// UpsertCorpus mirrors a Corpus and re-derives the knowledge bases
// using it.
//
// A connection change moves more than its own record: it can change a knowledge
// base's audience (the role union), its tool list (a GET face toggled), and its
// generated markdown (a member renamed). So it schedules the same debounced
// re-derivation a Tool change does.
func (ix *Indexer) UpsertCorpus(ctx context.Context, conn CorpusDescriptor) error {
	ix.mu.Lock()
	ix.connections[conn.ID] = conn
	ix.mu.Unlock()

	// A per-member read tool is no longer generated — one read per knowledge
	// base replaced them — so any record an earlier build wrote is removed
	// here rather than left to dangle in the catalog forever.
	if err := ix.stores.Tools.Delete(ctx, []string{CorpusGetToolID(conn.ID)}); err != nil {
		return err
	}

	// The read tool itself belongs to the knowledge base, so it is (re)written
	// by the re-derivation below rather than here.
	ix.scheduleSkillReindex()
	return nil
}

// DeleteCorpus drops a connection and re-derives what referenced it.
//
// The knowledge bases keep working over their remaining members — a vanished
// member is a dangling ref, which contributes nothing rather than failing the
// whole skill closed.
func (ix *Indexer) DeleteCorpus(ctx context.Context, id string) error {
	ix.mu.Lock()
	delete(ix.connections, id)
	ix.mu.Unlock()

	if err := ix.stores.Tools.Delete(ctx, []string{CorpusGetToolID(id)}); err != nil {
		return err
	}
	ix.scheduleSkillReindex()
	return nil
}

// UpsertKnowledgeBase mirrors a KnowledgeBase and indexes what it derives.
// writeKnowledgeBaseTools makes the catalog match what this knowledge base
// currently generates — writing what it produces and removing what it does not.
//
// One implementation because there are two callers, and the last time they each
// had their own, only one of them removed stale tools. The result was a
// withdrawn capability that vanished from the skill's refs and stayed in the
// catalog for the planner to find.
func (ix *Indexer) writeKnowledgeBaseTools(
	ctx context.Context,
	kb KnowledgeBaseDescriptor,
	connections map[string]CorpusDescriptor,
) error {
	generated := knowledgeBaseTools(kb, connections)
	written := make(map[string]struct{}, len(generated))
	for _, tool := range generated {
		if err := upsertHidden(ctx, ix.stores.Tools, tool); err != nil {
			return err
		}
		written[tool.ID] = struct{}{}
	}

	var stale []string
	for _, id := range knowledgeBaseToolIDs(kb.ID) {
		if _, ok := written[id]; !ok {
			stale = append(stale, id)
		}
	}
	if len(stale) == 0 {
		return nil
	}
	return ix.stores.Tools.Delete(ctx, stale)
}

// knowledgeBaseToolIDs is every id a knowledge base owns, generated or not.
//
// The fetch id is listed although no fetch tool exists: it is how a record
// written by an older build gets cleaned up.
func knowledgeBaseToolIDs(id string) []string {
	return []string{
		KnowledgeBaseSearchToolID(id),
		KnowledgeBaseReadToolID(id),
		KnowledgeBaseFetchToolID(id),
	}
}

func (ix *Indexer) UpsertKnowledgeBase(ctx context.Context, kb KnowledgeBaseDescriptor) error {
	ix.mu.Lock()
	ix.knowledgeBases[kb.ID] = kb
	connections := ix.corporaSnapshot()
	ix.mu.Unlock()

	if err := ix.writeKnowledgeBaseTools(ctx, kb, connections); err != nil {
		return err
	}

	derived := DeriveKnowledgeBaseSkill(kb, connections)
	return upsertOne(ctx, ix.stores.Skills, derived.ID, derived.EmbeddingText(),
		derived.EffectiveRoles, derived.Unrestricted, derived)
}

// DeleteKnowledgeBase removes a knowledge base and everything derived from it.
//
// The skill id is the DERIVED one (`kb:<name>`), not the CR name: deleting by CR
// name would leave the skill in the catalog, still selectable, pointing at tools
// that no longer exist.
func (ix *Indexer) DeleteKnowledgeBase(ctx context.Context, id string) error {
	ix.mu.Lock()
	delete(ix.knowledgeBases, id)
	ix.mu.Unlock()

	if err := ix.stores.Tools.Delete(ctx, []string{
		KnowledgeBaseSearchToolID(id), KnowledgeBaseFetchToolID(id),
	}); err != nil {
		return err
	}
	return ix.stores.Skills.Delete(ctx, []string{KnowledgeBaseSkillID(id)})
}

// reindexKnowledgeBases re-derives every knowledge base's skill. Called from
// the same debounced pass that re-derives authored skills, so one burst of CR
// applies costs one re-derivation rather than one per event.
//
// Caller must NOT hold ix.mu.
func (ix *Indexer) reindexKnowledgeBases(ctx context.Context) error {
	ix.mu.Lock()
	connections := ix.corporaSnapshot()
	bases := make([]KnowledgeBaseDescriptor, 0, len(ix.knowledgeBases))
	for _, kb := range ix.knowledgeBases {
		bases = append(bases, kb)
	}
	ix.mu.Unlock()

	if len(bases) == 0 {
		return nil
	}

	records := make([]vectorstore.Record, 0, len(bases))
	for _, kb := range bases {
		if err := ix.writeKnowledgeBaseTools(ctx, kb, connections); err != nil {
			return err
		}
		derived := DeriveKnowledgeBaseSkill(kb, connections)
		rec, err := record(derived.ID, derived.EmbeddingText(),
			derived.EffectiveRoles, derived.Unrestricted, derived)
		if err != nil {
			return err
		}
		records = append(records, rec)
	}
	return ix.stores.Skills.Upsert(ctx, records)
}

// corporaSnapshot copies the mirror so derivation runs without the lock.
// Caller must hold ix.mu.
func (ix *Indexer) corporaSnapshot() map[string]CorpusDescriptor {
	out := make(map[string]CorpusDescriptor, len(ix.connections))
	for id, conn := range ix.connections {
		out[id] = conn
	}
	return out
}

// knowledgeBaseTools is the tool records a knowledge base implies: its own
// search, plus the GET face of every api-enabled member.
//
// A `/fetch` tool is deliberately NOT offered yet. The whole-document read it
// would provide has no dispatch path — SearchKnowledgeBase is the only
// execution route — and building the real one means a source reader against
// Atlassian's actual API shapes, the adapter layer ADR 0040 defers. Offering
// it before then would steer the planner into a call that silently degrades to
// a similarity search over the source id. KnowledgeBaseExecSpec.Operation stays
// as scaffolding for that deferred path, and dispatch fails closed on any
// operation but "search".
//
// The member GET tools are (re)written here as well as by UpsertCorpus
// because a knowledge base may be indexed before its members are.
func knowledgeBaseTools(kb KnowledgeBaseDescriptor, connections map[string]CorpusDescriptor) []ToolDescriptor {
	derived := DeriveKnowledgeBaseSkill(kb, connections)
	roles := derived.EffectiveRoles
	exec := knowledgeBaseExec(kb, connections)

	tools := []ToolDescriptor{
		{
			ID: KnowledgeBaseSearchToolID(kb.ID),
			Description: fmt.Sprintf(
				"Search the %s knowledge base for passages relevant to a question.", kb.Label()),
			Input: "A natural-language question, and optionally a list of member connection " +
				"names to narrow the search to.",
			Output: "Ranked passages, each with the title and URL of its source as confirmed " +
				"readable by the calling user, plus how many sources were withheld or " +
				"could not be checked.",
			AllowedRoles:      roles,
			KnowledgeBaseExec: exec("search"),
		},
	}

	// ONE read tool, not one per member. A knowledge base with eight members
	// used to produce eight near-identical "Read from X" tools competing inside
	// a single skill — the near-identical descriptions ADR 0039 §5 warns about,
	// reproduced one level down — and the model had to pick the right tool
	// before it could ask the right question. The corpus travels in the input
	// instead, where the model can read it straight off a citation.
	if readable := readableMembers(kb, connections); len(readable) > 0 {
		tools = append(tools, knowledgeBaseReadTool(kb, readable, exec("read")))
	}
	return tools
}

// readableMembers are the members that can actually serve a per-user read.
//
// A member with no identity provider is excluded: the read face has no
// service-credential mode by design (ADR 0040), so listing it would offer the
// model an option that always fails.
func readableMembers(
	kb KnowledgeBaseDescriptor,
	connections map[string]CorpusDescriptor,
) []CorpusDescriptor {
	readable := make([]CorpusDescriptor, 0, len(kb.CorpusRefs))
	for _, ref := range kb.CorpusRefs {
		conn, ok := connections[ref]
		if ok && conn.APIEnabled && len(conn.IdentityProviders) > 0 {
			readable = append(readable, conn)
		}
	}
	return readable
}

// knowledgeBaseReadTool is the ONE live read a knowledge base offers.
func knowledgeBaseReadTool(
	kb KnowledgeBaseDescriptor,
	readable []CorpusDescriptor,
	exec *KnowledgeBaseExecSpec,
) ToolDescriptor {
	names := make([]string, 0, len(readable))
	roles := map[string]bool{}
	for _, conn := range readable {
		names = append(names, fmt.Sprintf("%s (%s)", conn.ID, conn.Label()))
		for _, role := range conn.AllowedRoles {
			roles[role] = true
		}
	}

	// Union to invoke, as the search tool does (ADR 0039 §4): a caller who may
	// reach ANY member may call it, and which documents they can actually read
	// is settled per read by the source itself.
	allowed := make([]string, 0, len(roles))
	for role := range roles {
		allowed = append(allowed, role)
	}
	sort.Strings(allowed)

	return ToolDescriptor{
		ID: KnowledgeBaseReadToolID(kb.ID),
		Description: fmt.Sprintf(
			"Read the full, current text of one document in %s. Use after searching, when a "+
				"passage is not enough or looks out of date.", kb.Label()),
		Input: fmt.Sprintf(
			"`<corpus>/<id>`, where <corpus> is one of: %s, and <id> is the resource id a "+
				"search result cites. Reads LIVE and as the asking user, so it can follow a "+
				"reference out of this knowledge base into anything that person has access "+
				"to — and refuses anything they cannot see.",
			strings.Join(names, ", ")),
		Output:            "The document as the source returns it now, with a citation.",
		AllowedRoles:      allowed,
		KnowledgeBaseExec: exec,
	}
}

// corpusGetTool is a Connection's scope-enforced GET face (ADR 0038 §5),
// carrying that corpus's OWN roles rather than the knowledge base's union —
// it is one source's capability, not the composition's.

// upsertHidden writes a tool that may be referenced but never retrieved.
func upsertHidden(ctx context.Context, store vectorstore.Store, tool ToolDescriptor) error {
	rec, err := record(tool.ID, tool.EmbeddingText(), tool.AllowedRoles, false, tool)
	if err != nil {
		return err
	}
	rec.Hidden = true
	return store.Upsert(ctx, []vectorstore.Record{rec})
}

// knowledgeBaseExec builds the execution spec both generated tools carry.
//
// Members are snapshotted at index time rather than resolved at call time, so
// the executing side works from exactly the membership the planner was offered
// — a knowledge base that changed mid-turn cannot silently widen what a search
// consults.
func knowledgeBaseExec(
	kb KnowledgeBaseDescriptor,
	connections map[string]CorpusDescriptor,
) func(operation string) *KnowledgeBaseExecSpec {
	members := make([]KnowledgeBaseExecMember, 0, len(kb.CorpusRefs))
	for _, ref := range kb.CorpusRefs {
		conn, ok := connections[ref]
		if !ok {
			continue // dangling; the controller reports it in status
		}
		members = append(members, KnowledgeBaseExecMember{
			ID:                conn.ID,
			Label:             conn.Label(),
			Collection:        conn.Collection,
			AllowedRoles:      conn.AllowedRoles,
			Granularity:       providerGranularity(conn.Provider),
			IdentityProviders: conn.IdentityProviders,
		})
	}

	return func(operation string) *KnowledgeBaseExecSpec {
		return &KnowledgeBaseExecSpec{
			KnowledgeBaseID:           kb.ID,
			DisplayName:               kb.Label(),
			Operation:                 operation,
			Members:                   members,
			DisclosePartialVisibility: kb.DisclosePartialVisibility,
		}
	}
}

// providerGranularity is the unit a provider authorizes at (ADR 0040).
//
// Slack authorizes a CHANNEL — membership is the access unit and there is no
// per-message permission — so one probe settles every candidate from that
// connection. Anything unrecognised is probed per RESOURCE: the finer unit is
// the safe default, since assuming per-connection would let one allowed
// resource vouch for every other candidate from that source.
func providerGranularity(provider string) string {
	if provider == "slack" {
		return "connection"
	}
	return "resource"
}
