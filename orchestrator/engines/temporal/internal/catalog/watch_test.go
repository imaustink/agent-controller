package catalog

import "testing"

func resourcesOf(ws []watchSpec) []string {
	out := make([]string, 0, len(ws))
	for _, w := range ws {
		out = append(out, w.gvr.Resource)
	}
	return out
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPlanWatchGroups(t *testing.T) {
	catalog := []watchSpec{{gvr: ToolGVR}, {gvr: AgentGVR}}
	kb := []watchSpec{{gvr: CorpusGVR}, {gvr: KnowledgeBaseGVR}}
	catalogRes := []string{ToolGVR.Resource, AgentGVR.Resource}
	kbRes := []string{CorpusGVR.Resource, KnowledgeBaseGVR.Resource}
	allRes := append(append([]string{}, catalogRes...), kbRes...)

	t.Run("no KB watches collapses to one group", func(t *testing.T) {
		// Knowledge bases disabled: a single group, KB namespace irrelevant.
		groups := planWatchGroups("cat-ns", "kb-ns", catalog, nil)
		if len(groups) != 1 || groups[0].namespace != "cat-ns" || !eq(resourcesOf(groups[0].watches), catalogRes) {
			t.Fatalf("got %+v", groups)
		}
	})

	t.Run("empty KB namespace shares the catalog namespace", func(t *testing.T) {
		groups := planWatchGroups("cat-ns", "", catalog, kb)
		if len(groups) != 1 || groups[0].namespace != "cat-ns" || !eq(resourcesOf(groups[0].watches), allRes) {
			t.Fatalf("got %+v", groups)
		}
	})

	t.Run("KB namespace equal to catalog namespace shares one factory", func(t *testing.T) {
		groups := planWatchGroups("cat-ns", "cat-ns", catalog, kb)
		if len(groups) != 1 || !eq(resourcesOf(groups[0].watches), allRes) {
			t.Fatalf("got %+v", groups)
		}
	})

	t.Run("distinct KB namespace splits into two groups", func(t *testing.T) {
		groups := planWatchGroups("cat-ns", "kb-ns", catalog, kb)
		if len(groups) != 2 {
			t.Fatalf("want 2 groups, got %d: %+v", len(groups), groups)
		}
		// Tools/agents stay in the catalog namespace; corpora/KBs move to kb-ns.
		if groups[0].namespace != "cat-ns" || !eq(resourcesOf(groups[0].watches), catalogRes) {
			t.Fatalf("catalog group wrong: %+v", groups[0])
		}
		if groups[1].namespace != "kb-ns" || !eq(resourcesOf(groups[1].watches), kbRes) {
			t.Fatalf("kb group wrong: %+v", groups[1])
		}
	})
}
