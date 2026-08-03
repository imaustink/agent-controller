package callertools_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"

	"durable-agents/internal/callertools"
)

func msgs(t *testing.T, raw string) []callertools.WireMessage {
	t.Helper()
	var out []callertools.WireMessage
	require.NoError(t, json.Unmarshal([]byte(raw), &out))
	return out
}

// The standard OpenAI resume shape. Before this parsing existed upstream, prior
// tool results were dropped entirely — so a client's result vanished and the
// planner re-issued the same call forever.
func TestCollectPriorCallsPairsCallsWithResults(t *testing.T) {
	messages := msgs(t, `[
		{"role":"user","content":"what's the weather in Boston?"},
		{"role":"assistant","content":null,"tool_calls":[
			{"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{\"city\":\"Boston\"}"}}
		]},
		{"role":"tool","tool_call_id":"call_1","content":"18C, cloudy"}
	]`)

	calls := callertools.CollectPriorCalls(messages, 0)
	require.Len(t, calls, 1)
	require.Equal(t, "call_1", calls[0].ID)
	require.Equal(t, "get_weather", calls[0].Name)
	require.JSONEq(t, `{"city":"Boston"}`, calls[0].Arguments)
	require.Equal(t, "18C, cloudy", calls[0].Result)
}

func TestCollectPriorCallsHandlesSeveralCalls(t *testing.T) {
	messages := msgs(t, `[
		{"role":"user","content":"compare Boston and Denver"},
		{"role":"assistant","tool_calls":[
			{"id":"c1","function":{"name":"get_weather","arguments":"{\"city\":\"Boston\"}"}},
			{"id":"c2","function":{"name":"get_weather","arguments":"{\"city\":\"Denver\"}"}}
		]},
		{"role":"tool","tool_call_id":"c1","content":"18C"},
		{"role":"tool","tool_call_id":"c2","content":"25C"}
	]`)

	calls := callertools.CollectPriorCalls(messages, 0)
	require.Len(t, calls, 2)
	require.Equal(t, "18C", calls[0].Result)
	require.Equal(t, "25C", calls[1].Result)
}

// An unmatched result is skipped rather than guessed at: with no paired call
// there is no tool name to attribute it to, so it would enter planner history
// as an orphan blob.
func TestCollectPriorCallsSkipsAnOrphanResult(t *testing.T) {
	messages := msgs(t, `[
		{"role":"user","content":"hi"},
		{"role":"tool","tool_call_id":"never-requested","content":"stray"}
	]`)
	require.Empty(t, callertools.CollectPriorCalls(messages, 0))
}

// Only the exchange in flight counts. A call from an EARLIER exchange is
// already answered and must not be replayed into this turn's planner history.
func TestCollectPriorCallsIgnoresEarlierExchanges(t *testing.T) {
	messages := msgs(t, `[
		{"role":"user","content":"first question"},
		{"role":"assistant","tool_calls":[{"id":"old","function":{"name":"f","arguments":"{}"}}]},
		{"role":"tool","tool_call_id":"old","content":"old result"},
		{"role":"assistant","content":"here you go"},
		{"role":"user","content":"second question"}
	]`)

	// lastUserIndex is the SECOND user message.
	require.Empty(t, callertools.CollectPriorCalls(messages, 4))
}

func TestCollectPriorCallsNoneForAnOrdinaryTurn(t *testing.T) {
	messages := msgs(t, `[{"role":"user","content":"hello"}]`)
	require.Empty(t, callertools.CollectPriorCalls(messages, 0))
}

// The ordering that matters: a title-generation request carrying a client's
// tool array must return prose, never a tool call the client would then run as
// a side effect of rendering a chat title.
func TestIsInternalUITask(t *testing.T) {
	require.True(t, callertools.IsInternalUITask("### Task:\nGenerate a concise title"))
	require.True(t, callertools.IsInternalUITask("\n  ### Task:\nGenerate tags"))
	require.False(t, callertools.IsInternalUITask("what pods are running?"))
	require.False(t, callertools.IsInternalUITask("tell me about ### Task: prefixes"))
}

// A caller sending few tools pays nothing — no embedding, no vector round trip.
// That is what makes just-in-time vectorization affordable.
func TestResolveSkipsTheStoreBelowTopK(t *testing.T) {
	store := &countingStore{}
	tools := makeTools(t, 3)

	got := callertools.Resolve(context.Background(), "anything", tools, callertools.Choice{Kind: callertools.ChoiceAuto}, 5, store)
	require.Len(t, got, 3)
	require.Zero(t, store.indexCalls, "the store must not be consulted when there is nothing to prune")
	require.Zero(t, store.searchCalls)
}

func TestResolveRanksAboveTopK(t *testing.T) {
	tools := makeTools(t, 8)
	store := &countingStore{ranked: tools[5:8]}

	got := callertools.Resolve(context.Background(), "anything", tools, callertools.Choice{Kind: callertools.ChoiceAuto}, 3, store)
	require.Equal(t, tools[5:8], got)
	require.Equal(t, 1, store.indexCalls)
	require.Equal(t, 1, store.searchCalls)
}

func TestResolveDropsEverythingOnChoiceNone(t *testing.T) {
	store := &countingStore{}
	got := callertools.Resolve(context.Background(), "x", makeTools(t, 8), callertools.Choice{Kind: callertools.ChoiceNone}, 3, store)
	require.Empty(t, got)
	require.Zero(t, store.indexCalls)
}

// A named choice IS a selection: ranking one candidate against itself is
// overhead, and offering the others would contradict the caller.
func TestResolveBypassesRetrievalForANamedChoice(t *testing.T) {
	store := &countingStore{}
	tools := makeTools(t, 8)
	got := callertools.Resolve(context.Background(), "x", tools,
		callertools.Choice{Kind: callertools.ChoiceFunction, Name: tools[4].Name}, 3, store)

	require.Len(t, got, 1)
	require.Equal(t, tools[4].Name, got[0].Name)
	require.Zero(t, store.searchCalls)
}

// Degrade, never drop the feature: the caller still gets tool calling, just
// without relevance ranking.
func TestResolveTruncatesWhenTheStoreIsUnavailable(t *testing.T) {
	tools := makeTools(t, 8)

	require.Len(t, callertools.Resolve(context.Background(), "x", tools,
		callertools.Choice{Kind: callertools.ChoiceAuto}, 3, nil), 3)

	failing := &countingStore{searchErr: errFake}
	require.Len(t, callertools.Resolve(context.Background(), "x", tools,
		callertools.Choice{Kind: callertools.ChoiceAuto}, 3, failing), 3)

	// "The caller offered 8 tools and none were even considered" is the worse
	// failure, so an empty ranking truncates rather than dropping them all.
	empty := &countingStore{ranked: nil}
	require.Len(t, callertools.Resolve(context.Background(), "x", tools,
		callertools.Choice{Kind: callertools.ChoiceAuto}, 3, empty), 3)
}

// helpers

var errFake = errStr("qdrant unavailable")

type errStr string

func (e errStr) Error() string { return string(e) }

func makeTools(t *testing.T, n int) []callertools.Descriptor {
	t.Helper()
	out := make([]callertools.Descriptor, n)
	for i := range out {
		tool, err := callertools.New("tool_"+string(rune('a'+i)), "does thing", json.RawMessage(`{"type":"object"}`))
		require.NoError(t, err)
		out[i] = tool
	}
	return out
}

type countingStore struct {
	indexCalls, searchCalls int
	ranked                  []callertools.Descriptor
	searchErr               error
}

func (s *countingStore) Index(context.Context, []callertools.Descriptor) error {
	s.indexCalls++
	return nil
}

func (s *countingStore) Search(_ context.Context, _ string, _ []callertools.Descriptor, _ int) ([]callertools.Descriptor, error) {
	s.searchCalls++
	return s.ranked, s.searchErr
}

func (s *countingStore) Prune(context.Context, int64) (int, error) { return 0, nil }
