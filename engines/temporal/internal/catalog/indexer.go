package catalog

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/controller-agent/temporal-engine/internal/vectorstore"
)

// Indexer keeps in-memory mirrors of the catalog and pushes changes into the
// vector stores. Any tool/agent change schedules a debounced re-derivation of
// every skill's access roles, since those are intersections over refs
// (agent-controller ADR 0011 / 0020).
type Indexer struct {
	stores vectorstore.Collections

	mu     sync.Mutex
	tools  map[string]ToolDescriptor
	agents map[string]AgentDescriptor
	skills map[string]SkillDescriptor // as decoded, pre-derivation

	reindexDelay time.Duration
	reindexTimer *time.Timer
}

const defaultReindexDelay = 500 * time.Millisecond

func NewIndexer(stores vectorstore.Collections) *Indexer {
	return &Indexer{
		stores:       stores,
		tools:        map[string]ToolDescriptor{},
		agents:       map[string]AgentDescriptor{},
		skills:       map[string]SkillDescriptor{},
		reindexDelay: defaultReindexDelay,
	}
}

func (ix *Indexer) UpsertTool(ctx context.Context, tool ToolDescriptor) error {
	ix.mu.Lock()
	ix.tools[tool.ID] = tool
	ix.mu.Unlock()

	if err := upsertOne(ctx, ix.stores.Tools, tool.ID, tool.EmbeddingText(), tool.AllowedRoles, false, tool); err != nil {
		return err
	}
	ix.scheduleSkillReindex()
	return nil
}

func (ix *Indexer) DeleteTool(ctx context.Context, id string) error {
	ix.mu.Lock()
	delete(ix.tools, id)
	ix.mu.Unlock()

	if err := ix.stores.Tools.Delete(ctx, []string{id}); err != nil {
		return err
	}
	ix.scheduleSkillReindex()
	return nil
}

func (ix *Indexer) UpsertAgent(ctx context.Context, agent AgentDescriptor) error {
	ix.mu.Lock()
	ix.agents[agent.ID] = agent
	ix.mu.Unlock()

	if err := upsertOne(ctx, ix.stores.Agents, agent.ID, agent.EmbeddingText(), agent.AllowedRoles, false, agent); err != nil {
		return err
	}
	ix.scheduleSkillReindex()
	return nil
}

func (ix *Indexer) DeleteAgent(ctx context.Context, id string) error {
	ix.mu.Lock()
	delete(ix.agents, id)
	ix.mu.Unlock()

	if err := ix.stores.Agents.Delete(ctx, []string{id}); err != nil {
		return err
	}
	ix.scheduleSkillReindex()
	return nil
}

func (ix *Indexer) UpsertSkill(ctx context.Context, skill SkillDescriptor) error {
	ix.mu.Lock()
	ix.skills[skill.ID] = skill
	derived := DeriveSkillAccess(skill, ix.tools, ix.agents)
	ix.mu.Unlock()

	return upsertOne(ctx, ix.stores.Skills, derived.ID, derived.EmbeddingText(), derived.EffectiveRoles, derived.Unrestricted, derived)
}

func (ix *Indexer) DeleteSkill(ctx context.Context, id string) error {
	ix.mu.Lock()
	delete(ix.skills, id)
	ix.mu.Unlock()

	return ix.stores.Skills.Delete(ctx, []string{id})
}

// scheduleSkillReindex debounces bulk catalog changes (initial informer list,
// bursty applies) into one skill re-derivation pass.
func (ix *Indexer) scheduleSkillReindex() {
	ix.mu.Lock()
	defer ix.mu.Unlock()
	if ix.reindexTimer != nil {
		ix.reindexTimer.Stop()
	}
	ix.reindexTimer = time.AfterFunc(ix.reindexDelay, func() {
		// Detached from any request context: this is background maintenance.
		if err := ix.ReindexSkills(context.Background()); err != nil {
			log.Printf("skill reindex failed: %v", err)
		}
	})
}

// ReindexSkills re-derives every skill's access against the current
// tool/agent mirrors and upserts them all.
func (ix *Indexer) ReindexSkills(ctx context.Context) error {
	ix.mu.Lock()
	records := make([]vectorstore.Record, 0, len(ix.skills))
	for _, skill := range ix.skills {
		derived := DeriveSkillAccess(skill, ix.tools, ix.agents)
		rec, err := record(derived.ID, derived.EmbeddingText(), derived.EffectiveRoles, derived.Unrestricted, derived)
		if err != nil {
			ix.mu.Unlock()
			return err
		}
		records = append(records, rec)
	}
	ix.mu.Unlock()

	if len(records) == 0 {
		return nil
	}
	return ix.stores.Skills.Upsert(ctx, records)
}

func record(id, text string, roles []string, unrestricted bool, descriptor any) (vectorstore.Record, error) {
	raw, err := json.Marshal(descriptor)
	if err != nil {
		return vectorstore.Record{}, fmt.Errorf("marshal descriptor %s: %w", id, err)
	}
	return vectorstore.Record{
		ID:           id,
		Text:         text,
		Roles:        roles,
		Unrestricted: unrestricted,
		Descriptor:   raw,
	}, nil
}

func upsertOne(ctx context.Context, store vectorstore.Store, id, text string, roles []string, unrestricted bool, descriptor any) error {
	rec, err := record(id, text, roles, unrestricted, descriptor)
	if err != nil {
		return err
	}
	return store.Upsert(ctx, []vectorstore.Record{rec})
}
