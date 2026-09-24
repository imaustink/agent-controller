package activities_test

import (
	"context"
	"testing"

	"github.com/stretchr/testify/require"

	"github.com/controller-agent/temporal-engine/internal/temporal/activities"
)

func extract(t *testing.T, payload, defaultOwner, request string) (string, *fakeLLM) {
	t.Helper()
	fake := &fakeLLM{payload: payload}
	a := &activities.AgentLoopActivities{LLM: fake, DefaultGitHubOwner: defaultOwner}
	repo, err := a.ExtractTargetRepository(context.Background(), activities.ExtractTargetRepositoryInput{Request: request})
	require.NoError(t, err)
	return repo, fake
}

func TestAGitHubURLNamesTheRepositoryWithoutAModelCall(t *testing.T) {
	repo, fake := extract(t, `{"owner":"wrong","name":"wrong"}`, "",
		"please fix https://github.com/bitovi/bitovi-platform-services.git/pull/12")
	require.Equal(t, "bitovi/bitovi-platform-services", repo)
	require.Empty(t, fake.lastUser, "a URL is unambiguous; the model is not consulted")
}

func TestAnOwnerAndNameTheRequestSpellsOutAreAccepted(t *testing.T) {
	repo, _ := extract(t, `{"owner":"bitovi","name":"bitovi-platform-services"}`, "",
		"In bitovi/bitovi-platform-services, add the oikb daemon to gitops/agent-controller/values.yaml.")
	require.Equal(t, "bitovi/bitovi-platform-services", repo)
}

// The model can pick among what the user wrote, never invent past it: a name
// or owner that is not in the request is dropped, and the gate then asks.
func TestAModelAnswerTheRequestDoesNotSupportIsDropped(t *testing.T) {
	cases := map[string]string{
		"invented name":  `{"owner":"bitovi","name":"secret-repo"}`,
		"invented owner": `{"owner":"someone-else","name":"bitovi-platform-services"}`,
		"a file path":    `{"owner":"gitops","name":"agent-controller/values.yaml"}`,
		"a substring":    `{"owner":"","name":"platform"}`,
	}
	for label, payload := range cases {
		repo, _ := extract(t, payload, "bitovi",
			"In bitovi-platform-services, add the oikb daemon to gitops/agent-controller/values.yaml.")
		require.Empty(t, repo, label)
	}
}

func TestABareNameTakesTheDeploymentsDefaultOwner(t *testing.T) {
	repo, _ := extract(t, `{"owner":"","name":"bitovi-platform-services"}`, "bitovi",
		"add the oikb daemon to bitovi-platform-services")
	require.Equal(t, "bitovi/bitovi-platform-services", repo)
}

// Whose repository a bare name refers to is not something to guess.
func TestABareNameWithNoDefaultOwnerStaysUnresolved(t *testing.T) {
	repo, _ := extract(t, `{"owner":"","name":"bitovi-platform-services"}`, "",
		"add the oikb daemon to bitovi-platform-services")
	require.Empty(t, repo)
}

func TestNoRepositoryNamedIsEmptyNotAnError(t *testing.T) {
	repo, _ := extract(t, `{"owner":"","name":""}`, "bitovi", "what's the weather like?")
	require.Empty(t, repo)
}
