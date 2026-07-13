package executor

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Config is the sidecar's process configuration (from env in main.go).
type Config struct {
	// Runtime this sidecar serves; a request for a different runtime is rejected.
	Runtime string
	// SocketPath is the unix socket to listen on.
	SocketPath string
	// CacheDir is where fetched packages are cached (shared volume).
	CacheDir string
	// AllowedRegistryHosts is the fail-closed allowlist of hosts a shell
	// sourceURL may point at (and, for node/python/go, is also enforced against
	// the configured registry hosts at resolve time). Empty = deny all.
	AllowedRegistryHosts []string
	// BwrapPath is the bubblewrap binary (default "bwrap").
	BwrapPath string
	// DefaultTimeoutSeconds bounds an execution when the request sets none.
	DefaultTimeoutSeconds int
}

var (
	sha256Pattern     = regexp.MustCompile(`^(sha256:)?[0-9a-f]{64}$`)
	unpinnedVersionRe = regexp.MustCompile(`[\^~<>=x*\s]`)
)

// validateRequest re-checks the integrity constraints the orchestrator/CRD
// already enforce (defense in depth: this sidecar must never fetch unpinned or
// unverified code, regardless of what reached it). Returns a human-readable
// reason, or "" when valid.
func (c Config) validateRequest(req RunRequest) string {
	if req.Runtime != c.Runtime {
		return fmt.Sprintf("runtime %q does not match this executor (%q)", req.Runtime, c.Runtime)
	}
	switch req.Runtime {
	case "shell":
		host, reason := allowedHost(req.SourceURL, c.AllowedRegistryHosts)
		if reason != "" {
			return reason
		}
		_ = host
		if !sha256Pattern.MatchString(req.Checksum) {
			return "shell runtime requires a sha256 checksum"
		}
	case "node", "python", "go":
		if req.Package == "" {
			return req.Runtime + " runtime requires a package"
		}
		if req.Version == "" {
			return req.Runtime + " runtime requires an exact pinned version"
		}
		if isUnpinned(req.Version) {
			return fmt.Sprintf("version %q must be exact, not a range or tag", req.Version)
		}
		if req.Checksum != "" && !sha256Pattern.MatchString(req.Checksum) {
			return "checksum, when set, must be a sha256 digest"
		}
	default:
		return fmt.Sprintf("unsupported runtime %q", req.Runtime)
	}
	return ""
}

func isUnpinned(v string) bool {
	if v == "latest" || v == "*" {
		return true
	}
	return unpinnedVersionRe.MatchString(v)
}

// allowedHost parses rawURL, requires https, and requires its host to be in the
// allowlist (fail-closed). Returns the host and a reason ("" when allowed).
func allowedHost(rawURL string, allowlist []string) (string, string) {
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return "", "sourceURL must be a valid https:// URL"
	}
	host := strings.ToLower(u.Hostname())
	for _, allowed := range allowlist {
		if strings.EqualFold(strings.TrimSpace(allowed), host) {
			return host, ""
		}
	}
	return host, fmt.Sprintf("host %q is not in the registry allowlist", host)
}
