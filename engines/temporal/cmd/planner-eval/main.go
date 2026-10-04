// Command planner-eval scores candidate planner models on the knowledge-base
// decisions that matter, offline and without production data.
//
// It drives the engine's REAL PlanAction against the REAL generated skill
// prompt and tool list for an SNC-shaped knowledge base, at the decision points
// where a weak planner fails: stopping after one search, answering a document
// question from fragments instead of reading the documents, and picking "the
// latest" from relevance-ranked search instead of asking for recent items. The
// tool results it feeds back are synthetic but rendered by the engine's own
// code, so the model sees exactly the shape production would show it.
//
// Usage (any OpenAI-compatible endpoint; the key is read from the env var named
// by -key-env and never printed):
//
//	go run ./cmd/planner-eval -models gpt-4o-2024-08-06,gpt-4.1 -runs 3
//	go run ./cmd/planner-eval -base-url https://api.anthropic.com/v1 \
//	    -key-env ANTHROPIC_API_KEY -models claude-sonnet-5
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/controller-agent/temporal-engine/internal/catalog"
	"github.com/controller-agent/temporal-engine/internal/corpus"
	"github.com/controller-agent/temporal-engine/internal/llm"
	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

func main() {
	baseURL := flag.String("base-url", envOr("OPENAI_BASE_URL", "https://api.openai.com/v1"), "OpenAI-compatible base URL")
	keyEnv := flag.String("key-env", "OPENAI_API_KEY", "env var holding the API key")
	models := flag.String("models", "", "comma-separated model ids to compare (required)")
	runs := flag.Int("runs", 3, "runs per scenario per model (models are not deterministic)")
	flag.Parse()

	key := os.Getenv(*keyEnv)
	if *models == "" || key == "" {
		fmt.Fprintf(os.Stderr, "need -models and a key in $%s\n", *keyEnv)
		os.Exit(2)
	}

	skill, tools := sncKnowledgeBase()
	scenarios := scenarios(tools)

	fmt.Printf("%-28s %-40s %8s %8s %10s\n", "model", "scenario", "pass", "invalid", "avg ms")
	for _, model := range strings.Split(*models, ",") {
		model = strings.TrimSpace(model)
		planner := &activities.AgentLoopActivities{LLM: llm.New(*baseURL, key, model)}
		var totalPass, total int
		for _, sc := range scenarios {
			pass, invalid, elapsed := 0, 0, time.Duration(0)
			for i := 0; i < *runs; i++ {
				ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
				start := time.Now()
				plan, err := planner.PlanAction(ctx, activities.PlanActionInput{
					Request:       sc.request,
					SkillMarkdown: skill.Markdown,
					Tools:         tools,
					History:       sc.history,
					RespondOnly:   sc.respondOnly,
				})
				elapsed += time.Since(start)
				cancel()
				switch {
				case err != nil:
					invalid++
				case sc.pass(plan):
					pass++
				}
			}
			totalPass += pass
			total += *runs
			fmt.Printf("%-28s %-40s %5d/%-2d %8d %10d\n",
				model, sc.name, pass, *runs, invalid, elapsed.Milliseconds()/int64(*runs))
		}
		fmt.Printf("%-28s %-40s %5d/%-2d\n\n", model, "TOTAL", totalPass, total)
	}
}

type scenario struct {
	name        string
	request     string
	history     []activities.ActionRecord
	respondOnly bool
	pass        func(activities.PlannedAction) bool
}

const (
	searchTool = "kb:snc/search"
	readTool   = "kb:snc/read"
	recentTool = "kb:snc/recent"
	lookupTool = "kb:snc/lookup"
)

var citation = regexp.MustCompile(`\[\d+\]`)

func scenarios(tools []catalog.ToolDescriptor) []scenario {
	retroQ := "What were the action items for SNC project retros?"
	latestQ := "What was the most recent slack message in team-snc?"

	retroSearch := activities.ActionRecord{ToolID: searchTool, Input: "SNC project retro action items", Succeeded: true,
		Result: corpus.Render(corpus.RenderInput{Outcome: corpus.RetrieveOutcome{Chunks: []corpus.AuthorizedChunk{
			passage("snc-confluence", "2114289728", "End of Project Retro, part 2", "https://wiki/2114289728",
				"What could be better: change requests arrived mid-sprint and the roadmap kept moving. Action items (1 of 6): Set up an internal Kanban board to track work …"),
			passage("snc-confluence", "2201000001", "2026-07-17 Retro", "https://wiki/2201000001",
				"Went well: knowledge transfer with SNC's developers. Discussion: the discovery process is still unclear to new team members …"),
			passage("snc-confluence", "2586083330", "2026-09-10 Monthly Prep", "https://wiki/2586083330",
				"Agenda: budget burn, PDS integration status, Blue Agent follow-on proposal."),
		}}}),
	}
	readEnd := activities.ActionRecord{ToolID: readTool, Input: "snc-confluence/2114289728", Succeeded: true,
		Result: "[4] Live read from SNC Confluence (2114289728) — https://wiki/2114289728:\n\n# End of Project Retro, part 2\n## Action items\n" +
			"- [ ] Ask Brad how we can handle change requests / scope increases while keeping business continuity\n" +
			"- [ ] Review roadmap with Brad to avoid switching out developers\n- [ ] Set up an internal Kanban board to track work\n" +
			"- [ ] Hold an internal biweekly\n- [ ] Make sure we hold an end-of-project customer retro where we can flag AI limitations\n" +
			"- [ ] Document the change order process (Kyle)\n"}
	read717 := activities.ActionRecord{ToolID: readTool, Input: "snc-confluence/2201000001", Succeeded: true,
		Result: "[5] Live read from SNC Confluence (2201000001) — https://wiki/2201000001:\n\n# 2026-07-17 Retro\n## Action items\n" +
			"- [ ] Connect Paul with Jason to talk about the discovery process\n"}

	slackSearch := activities.ActionRecord{ToolID: searchTool, Input: "most recent message team-snc", Succeeded: true,
		Result: corpus.Render(corpus.RenderInput{Outcome: corpus.RetrieveOutcome{Chunks: []corpus.AuthorizedChunk{
			passage("snc-slack-team", "C0ADFD16CDB/1789155720.138109", "Hey team — I've set up a new Jira Initiative", "https://slack/1",
				"Hey team — I've set up a new Jira Initiative to track the PDS Integration work …"),
			passage("snc-slack-team", "C0ADFD16CDB/1787245159.195829", "Brad just dropped this in our chat", "https://slack/2",
				"Brad just dropped this in our chat 5 mins ago: SNC leadership desires to move PDS Integration into PE in 4Q …"),
		}}}),
	}
	recent := activities.ActionRecord{ToolID: recentTool, Input: "#team-snc", Succeeded: true,
		Result: "Most recent in SNC (#team-snc), newest first:\n" +
			"\n- [1] @U0C3DFPAEP8 has joined the channel — #team-snc · changed 2026-09-21T18:05:00Z\n  reference: snc-slack-team/C0ADFD16CDB/1790445900.000100\n  https://slack/join" +
			"\n- [2] for Evening Updates September 21, 2026 — #team-snc · changed 2026-09-21T17:00:00Z\n  reference: snc-slack-team/C0ADFD16CDB/1790442000.000200\n  https://slack/evening" +
			"\n- [3] for morning updates September 21, 2026 — #team-snc · changed 2026-09-21T13:00:00Z\n  reference: snc-slack-team/C0ADFD16CDB/1790427600.000300\n  https://slack/morning"}

	return []scenario{
		{
			name: "1 retro: starts by searching", request: retroQ,
			pass: func(p activities.PlannedAction) bool {
				return p.Action == activities.ActionCallTool && (p.ToolID == searchTool || p.ToolID == lookupTool)
			},
		},
		{
			name: "2 retro: reads docs, not fragments", request: retroQ,
			history: []activities.ActionRecord{retroSearch},
			pass: func(p activities.PlannedAction) bool {
				return p.Action == activities.ActionCallTool && p.ToolID == readTool &&
					(strings.Contains(p.ToolInput, "2114289728") || strings.Contains(p.ToolInput, "2201000001"))
			},
		},
		{
			name: "3 retro: answers from both docs", request: retroQ,
			history: []activities.ActionRecord{retroSearch, readEnd, read717},
			pass: func(p activities.PlannedAction) bool {
				r := strings.ToLower(p.Response)
				return p.Action == activities.ActionRespond && strings.Contains(r, "kanban") &&
					strings.Contains(r, "paul") && citation.MatchString(p.Response)
			},
		},
		{
			name: "4 latest: asks recent for team-snc", request: latestQ,
			pass: func(p activities.PlannedAction) bool {
				return p.Action == activities.ActionCallTool && p.ToolID == recentTool &&
					strings.Contains(strings.ToLower(p.ToolInput), "team-snc")
			},
		},
		{
			name: "5 latest: not fooled by search", request: latestQ,
			history: []activities.ActionRecord{slackSearch},
			pass: func(p activities.PlannedAction) bool {
				return p.Action == activities.ActionCallTool && p.ToolID == recentTool
			},
		},
		{
			name: "6 latest: answers the newest, cited", request: latestQ,
			history: []activities.ActionRecord{recent},
			pass: func(p activities.PlannedAction) bool {
				r := strings.ToLower(p.Response)
				return p.Action == activities.ActionRespond && strings.Contains(r, "joined") &&
					strings.Contains(p.Response, "[1]")
			},
		},
	}
}

// sncKnowledgeBase is an SNC-shaped knowledge base: the generated skill and
// tools exactly as the indexer would produce them for these members.
func sncKnowledgeBase() (catalog.SkillDescriptor, []catalog.ToolDescriptor) {
	member := func(id, provider, label, desc, idp string) catalog.CorpusDescriptor {
		return catalog.CorpusDescriptor{
			ID: id, Provider: provider, DisplayName: label, Description: desc,
			AllowedRoles: []string{"reader"}, Collection: "corpus_" + id,
			APIEnabled: true, IdentityProviders: []string{idp},
		}
	}
	connections := map[string]catalog.CorpusDescriptor{
		"snc-confluence":       member("snc-confluence", "confluence", "SNC Confluence", "The SNC Confluence space: retros, meeting notes, plans.", "atlassian"),
		"snc-drive":            member("snc-drive", "gdrive", "SNC Drive folder", "Proposals, SOWs and session notes.", "google"),
		"snc-slack-team":       member("snc-slack-team", "slack", "#team-snc", "The SNC delivery team's channel.", "slack"),
		"snc-slack-leadership": member("snc-slack-leadership", "slack", "#team-snc-leadership", "The SNC account leadership channel.", "slack"),
	}
	kb := catalog.KnowledgeBaseDescriptor{
		ID: "snc", DisplayName: "SNC", Description: "Sierra Nevada Corporation (SNC) client engagement.",
		CorpusRefs:                []string{"snc-confluence", "snc-drive", "snc-slack-team", "snc-slack-leadership"},
		DisclosePartialVisibility: true,
	}
	return catalog.DeriveKnowledgeBaseSkill(kb, connections), catalog.KnowledgeBaseTools(kb, connections)
}

func passage(corpusID, sourceID, title, url, text string) corpus.AuthorizedChunk {
	return corpus.AuthorizedChunk{
		Title: title, URL: url,
		Chunk: corpus.Chunk{CorpusID: corpusID, CorpusLabel: corpusID, SourceID: sourceID, Text: text},
	}
}

func envOr(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
