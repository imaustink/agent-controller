package catalog

import (
	"context"
	"fmt"

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

// UpsertConnection mirrors a Connection and re-derives the knowledge bases
// using it.
//
// A connection change moves more than its own record: it can change a knowledge
// base's audience (the role union), its tool list (a GET face toggled), and its
// generated markdown (a member renamed). So it schedules the same debounced
// re-derivation a Tool change does.
func (ix *Indexer) UpsertConnection(ctx context.Context, conn ConnectionDescriptor) error {
	ix.mu.Lock()
	ix.connections[conn.ID] = conn
	ix.mu.Unlock()

	// The GET face is a tool a knowledge base may declare; without a record it
	// would dangle when the skill resolves its refs.
	if conn.APIEnabled {
		tool := connectionGetTool(conn)
		if err := upsertHidden(ctx, ix.stores.Tools, tool); err != nil {
			return err
		}
	} else if err := ix.stores.Tools.Delete(ctx, []string{ConnectionGetToolID(conn.ID)}); err != nil {
		return err
	}

	ix.scheduleSkillReindex()
	return nil
}

// DeleteConnection drops a connection and re-derives what referenced it.
//
// The knowledge bases keep working over their remaining members — a vanished
// member is a dangling ref, which contributes nothing rather than failing the
// whole skill closed.
func (ix *Indexer) DeleteConnection(ctx context.Context, id string) error {
	ix.mu.Lock()
	delete(ix.connections, id)
	ix.mu.Unlock()

	if err := ix.stores.Tools.Delete(ctx, []string{ConnectionGetToolID(id)}); err != nil {
		return err
	}
	ix.scheduleSkillReindex()
	return nil
}

// UpsertKnowledgeBase mirrors a KnowledgeBase and indexes what it derives.
func (ix *Indexer) UpsertKnowledgeBase(ctx context.Context, kb KnowledgeBaseDescriptor) error {
	ix.mu.Lock()
	ix.knowledgeBases[kb.ID] = kb
	connections := ix.connectionsSnapshot()
	ix.mu.Unlock()

	for _, tool := range knowledgeBaseTools(kb, connections) {
		if err := upsertHidden(ctx, ix.stores.Tools, tool); err != nil {
			return err
		}
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
	connections := ix.connectionsSnapshot()
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
		for _, tool := range knowledgeBaseTools(kb, connections) {
			if err := upsertHidden(ctx, ix.stores.Tools, tool); err != nil {
				return err
			}
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

// connectionsSnapshot copies the mirror so derivation runs without the lock.
// Caller must hold ix.mu.
func (ix *Indexer) connectionsSnapshot() map[string]ConnectionDescriptor {
	out := make(map[string]ConnectionDescriptor, len(ix.connections))
	for id, conn := range ix.connections {
		out[id] = conn
	}
	return out
}

// knowledgeBaseTools is the tool records a knowledge base implies: its own
// search and fetch, plus the GET face of every api-enabled member.
//
// The member GET tools are (re)written here as well as by UpsertConnection
// because a knowledge base may be indexed before its members are.
func knowledgeBaseTools(kb KnowledgeBaseDescriptor, connections map[string]ConnectionDescriptor) []ToolDescriptor {
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
		{
			ID: KnowledgeBaseFetchToolID(kb.ID),
			Description: fmt.Sprintf(
				"Read a whole document from the %s knowledge base, live from its source.", kb.Label()),
			Input:             "The id of a source returned by this knowledge base's search tool.",
			Output:            "The current document, as the calling user is permitted to see it.",
			AllowedRoles:      roles,
			KnowledgeBaseExec: exec("fetch"),
		},
	}

	for _, ref := range kb.ConnectionRefs {
		conn, ok := connections[ref]
		if !ok || !conn.APIEnabled {
			continue
		}
		tools = append(tools, connectionGetTool(conn))
	}
	return tools
}

// connectionGetTool is a Connection's scope-enforced GET face (ADR 0038 §5),
// carrying that connection's OWN roles rather than the knowledge base's union —
// it is one source's capability, not the composition's.
func connectionGetTool(conn ConnectionDescriptor) ToolDescriptor {
	return ToolDescriptor{
		ID: ConnectionGetToolID(conn.ID),
		Description: fmt.Sprintf(
			"Read the current state of a resource in %s (%s). %s",
			conn.Label(), conn.Provider, conn.Description),
		Input: "The id or path of a resource inside this connection's scope. Requests " +
			"outside that scope are refused.",
		Output:       "The resource as the source returns it now, for the calling user.",
		AllowedRoles: conn.AllowedRoles,
	}
}

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
	connections map[string]ConnectionDescriptor,
) func(operation string) *KnowledgeBaseExecSpec {
	members := make([]KnowledgeBaseExecMember, 0, len(kb.ConnectionRefs))
	for _, ref := range kb.ConnectionRefs {
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
