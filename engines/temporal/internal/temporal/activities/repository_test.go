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

// A "." is part of a repository name, so a name truncated at one is not the
// name the user wrote: "platform" must not stand in for "platform.internal"
// and resolve, via the default owner, to a different repository.
func TestANameTruncatedAtADotIsNotAMention(t *testing.T) {
	repo, _ := extract(t, `{"owner":"","name":"platform"}`, "bitovi", "work in the platform.internal repo")
	require.Empty(t, repo)

	repo, _ = extract(t, `{"owner":"","name":"platform.internal"}`, "bitovi", "work in the platform.internal repo")
	require.Equal(t, "bitovi/platform.internal", repo)
}

// ...while the full stop at the end of a sentence is not part of the name.
func TestANameEndingASentenceIsStillAMention(t *testing.T) {
	for _, request := range []string{"fix the failing test in e2e-repo.", "fix it in e2e-repo. Thanks", "e2e-repo.\nthanks"} {
		repo, _ := extract(t, `{"owner":"","name":"e2e-repo"}`, "e2e-org", request)
		require.Equal(t, "e2e-org/e2e-repo", repo, request)
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
