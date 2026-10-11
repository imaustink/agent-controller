package activities

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"

	"github.com/controller-agent/temporal-engine/internal/authz"
	"github.com/controller-agent/temporal-engine/internal/llm"
)

const ExtractTargetRepositoryActivityName = "ExtractTargetRepository"

// ExtractTargetRepositoryInput is a chat request whose agent acts on a
// GitHub repository.
type ExtractTargetRepositoryInput struct {
	Request string `json:"request"`
}

var extractRepositorySchema = llm.ResponseSchema{
	Name: "extract_repository",
	Schema: json.RawMessage(`{
		"type": "object",
		"properties": {
			"owner": {"type": "string"},
			"name": {"type": "string"}
		},
		"required": ["owner", "name"],
		"additionalProperties": false
	}`),
}

// githubURLPattern finds a repository named by URL, which needs no model.
var githubURLPattern = regexp.MustCompile(`(?i)github\.com/([A-Za-z0-9_.-]+)/([A-Za-z0-9_.-]+)`)

// ExtractTargetRepository names the "owner/name" a chat request asks an agent
// to work in, or "" when it names none. An empty answer is not an error: the
// read gate turns it into a question back to the user.
//
// The model only reads the request. Everything it returns is then held to
// what the user literally wrote -- the name, and the owner if one is given,
// must both appear in the request -- so it can pick among repositories the
// user named but cannot invent one. A bare name takes DefaultGitHubOwner
// (one organization's deployment), and with no default it stays unresolved
// rather than guessing whose it is.
//
// None of this decides access. The read gate checks whatever comes out of
// here with the caller's own token (authz.gateRepository).
func (a *AgentLoopActivities) ExtractTargetRepository(ctx context.Context, in ExtractTargetRepositoryInput) (string, error) {
	if m := githubURLPattern.FindStringSubmatch(in.Request); m != nil {
		name := strings.TrimSuffix(m[2], ".git")
		if authz.ValidRepoPart(m[1]) && authz.ValidRepoPart(name) {
			return m[1] + "/" + name, nil
		}
	}

	raw, err := a.LLM.CompleteJSON(ctx, []llm.Message{
		{Role: "system", Content: "Identify the single GitHub repository the user is asking to have work done in. " +
			"Only count something the user explicitly identifies as a repository: written as owner/name, given as a " +
			"GitHub URL, or called a repository or repo (\"the e2e-repo repository\", \"in the api repo\"). " +
			"An ordinary word in the request is not a repository just because a repository could have that name: " +
			"in \"fix the failing test\" there is no repository, and \"test\" is not one. " +
			"Answer with its owner (a user or organization) and its name exactly as the user wrote them. " +
			"Leave owner empty if the user gave only the repository's name. Leave both empty if the user names no repository, " +
			"or names more than one and it is unclear which is meant. " +
			"Never infer or guess a repository the user did not name. A file or directory path, such as " +
			"gitops/agent-controller/values.yaml, is not a repository, even when it contains a slash."},
		{Role: "user", Content: in.Request},
	}, extractRepositorySchema)
	if err != nil {
		return "", err
	}
	var out struct {
		Owner string `json:"owner"`
		Name  string `json:"name"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", nil
	}
	return resolveExtractedRepository(in.Request, strings.TrimSpace(out.Owner), strings.TrimSpace(out.Name), a.DefaultGitHubOwner), nil
}

// resolveExtractedRepository holds a model's answer to the request's own text.
func resolveExtractedRepository(request, owner, name, defaultOwner string) string {
	name = strings.TrimSuffix(name, ".git")
	if !authz.ValidRepoPart(name) || !mentions(request, name) {
		return ""
	}
	if owner == "" {
		owner = defaultOwner
	} else if !mentions(request, owner) {
		return ""
	}
	if !authz.ValidRepoPart(owner) {
		return ""
	}
	return owner + "/" + name
}

// mentions reports whether word appears in text as a whole token, ignoring
// case. A plain substring test would let "api" match inside "rapid".
//
// Every character a repository name may contain continues the token on both
// sides, "." included, so "platform" is not mentioned by "platform.internal":
// a model that truncated that name must not resolve to a different
// repository. The one exception is a "." that ends a sentence ("fix it in
// e2e-repo."), which is followed by something no name contains, or by
// nothing at all.
func mentions(text, word string) bool {
	pattern := `(?i)(^|[^A-Za-z0-9_.-])` + regexp.QuoteMeta(word) + `($|[^A-Za-z0-9_.-]|\.($|[^A-Za-z0-9_.-]))`
	return regexp.MustCompile(pattern).MatchString(text)
}
