package authz

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/controller-agent/temporal-engine/internal/identitylink"
)

// TargetRepositoryEnv carries the repository the pre-flight verified into the
// run. The agent scopes its App write token to exactly this repository, so
// the check here and the credential there name the same thing.
const TargetRepositoryEnv = "AGENT_TARGET_REPOSITORY"

// RepoAccess is what a read check learned about one repository.
type RepoAccess int

const (
	// RepoReadable: the token can see the repository.
	RepoReadable RepoAccess = iota
	// RepoNotVisible: GitHub answered 404 or 403. GitHub reports a private
	// repository the token cannot see as 404, so "does not exist" and "you
	// may not read it" are deliberately the same answer.
	RepoNotVisible
	// RepoTokenRejected: GitHub answered 401. The token is dead, which says
	// nothing about the repository, so it must not read as a denial.
	RepoTokenRejected
)

// RepoReader checks whether a GitHub token can read a repository.
type RepoReader interface {
	CanRead(ctx context.Context, token, owner, name string) (RepoAccess, error)
}

// GitHubRepoReader asks GitHub directly, with the token under test.
type GitHubRepoReader struct {
	APIURL string
	Client *http.Client
}

func (r GitHubRepoReader) CanRead(ctx context.Context, token, owner, name string) (RepoAccess, error) {
	endpoint := strings.TrimRight(r.APIURL, "/") + "/repos/" + url.PathEscape(owner) + "/" + url.PathEscape(name)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return 0, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")

	client := r.Client
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("read check for %s/%s: %w", owner, name, err)
	}
	defer res.Body.Close()

	switch {
	case res.StatusCode == http.StatusOK:
		return RepoReadable, nil
	case res.StatusCode == http.StatusNotFound || res.StatusCode == http.StatusForbidden:
		return RepoNotVisible, nil
	case res.StatusCode == http.StatusUnauthorized:
		return RepoTokenRejected, nil
	default:
		// A 5xx or a rate limit is not an answer about access. Returning an
		// error lets the activity retry, and a turn that never gets an answer
		// fails rather than launching unchecked.
		return 0, fmt.Errorf("read check for %s/%s: GitHub answered %d", owner, name, res.StatusCode)
	}
}

// repoNamePattern is GitHub's charset for owners and repository names. It is
// what keeps a model-extracted name from smuggling a path into the URL.
var repoNamePattern = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

// ValidRepoPart reports whether s could be a GitHub owner or repository name.
func ValidRepoPart(s string) bool {
	return repoNamePattern.MatchString(s) && s != "." && s != ".."
}

// ParseRepository splits "owner/name", rejecting anything GitHub would not
// accept as either half.
func ParseRepository(repo string) (owner, name string, ok bool) {
	owner, name, found := strings.Cut(strings.TrimSpace(repo), "/")
	if !found || !ValidRepoPart(owner) || !ValidRepoPart(name) {
		return "", "", false
	}
	return owner, name, true
}

// gatesRepository reports whether an agent's runs act on a GitHub
// repository and so must pass the read gate. Declaring the github provider
// is what makes a run read as the caller (ADR 0041), so it is also what makes
// the caller's read access the condition for launching.
func gatesRepository(providers []string) bool {
	for _, p := range providers {
		if p == identitylink.ProviderGitHub {
			return true
		}
	}
	return false
}

// gateRepository decides whether this caller may have the agent work in the
// requested repository. A non-empty refusal is the complete user-facing text,
// and nothing launches.
//
// Two caller shapes, two sources of evidence:
//   - A per-user caller is checked with their OWN token. If GitHub will not
//     show them the repository, the agent does not start.
//   - A shared-subject caller (a webhook relay) has no token of its own; the
//     adapter already verified the sender's permission on the event's
//     repository before relaying (integration-gateway's collaborator check),
//     and vouched for the sender with a signed assertion. Without that
//     sender there is nobody whose access could have been checked, so the
//     turn is refused. That is exactly the shape of a chat turn that lost
//     its identity on the way here.
func (s *Service) gateRepository(ctx context.Context, req Request, userToken string) (string, error) {
	repo := req.TargetRepository
	if repo == "" {
		return fmt.Sprintf("Which GitHub repository should %s work in? Send your request again naming it as `owner/repo`.", req.AgentID), nil
	}
	owner, name, ok := ParseRepository(repo)
	if !ok {
		return fmt.Sprintf("`%s` isn't a GitHub repository I can work in. Name it as `owner/repo`.", repo), nil
	}

	if !req.Identity.PerUser {
		if req.SenderLogin == "" {
			return fmt.Sprintf("I couldn't verify who is asking, so I didn't start %s.", req.AgentID), nil
		}
		return "", nil
	}

	if userToken == "" {
		// Unreachable today: a per-user caller either resolved a github token
		// or returned link-required before this point. Refusing keeps a
		// future path that skips the link from launching unchecked.
		return fmt.Sprintf("I couldn't check your access to `%s`, so I didn't start %s.", repo, req.AgentID), nil
	}
	if s.deps.Repos == nil {
		return "", fmt.Errorf("the agent declares github but no repository reader is configured")
	}

	access, err := s.deps.Repos.CanRead(ctx, userToken, owner, name)
	if err != nil {
		return "", err
	}
	switch access {
	case RepoReadable:
		return "", nil
	case RepoTokenRejected:
		return "GitHub rejected your linked account's token, so I couldn't check your access to `" + repo +
			"`. Unlink and re-link your GitHub account, then send your request again.", nil
	default:
		return fmt.Sprintf("Your GitHub account can't see `%s`, so I didn't start %s.", repo, req.AgentID), nil
	}
}
