// Package identitylink is the client for agent-controller's
// integration-gateway credential API: GitHub links (ADR 0022) and per-user
// Claude credentials of both kinds (ADR 0027), stored durably in Kubernetes
// Secrets since ADR 0034.
//
// The gateway stays upstream. We speak its HTTP contract rather than
// reimplementing the OAuth device flow, the `claude setup-token` PTY, or the
// credential store — those are exactly the parts that belong to whoever runs
// them, and duplicating them would mean two implementations of credential
// keying, which upstream ADR 0030 §1 identifies as the shape of a real bug.
package identitylink

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Providers this system knows how to resolve.
const (
	ProviderGitHub       = "github"
	ProviderClaude       = "claude"
	ProviderClaudeRemote = "claude-remote"
)

// Flow shapes a started link can take.
const (
	FlowDevice   = "device"   // OAuth device flow: show a code, poll
	FlowAuthCode = "authcode" // browser redirect; nothing to poll
	FlowPage     = "page"     // a gateway-hosted page (the claude PTY flows)
)

// StartResult is a started link flow, discriminated by Flow. Only the fields
// belonging to that flow are populated.
type StartResult struct {
	Flow string `json:"flow"`

	VerificationURI     string `json:"verificationUri,omitempty"` // device
	UserCode            string `json:"userCode,omitempty"`        // device
	DeviceCode          string `json:"deviceCode,omitempty"`      // device
	PollIntervalSeconds int    `json:"pollIntervalSeconds,omitempty"`

	AuthorizeURL string `json:"authorizeUrl,omitempty"` // authcode
	PageURL      string `json:"pageUrl,omitempty"`      // page

	ExpiresInSeconds int `json:"expiresInSeconds,omitempty"`
}

// Token is a resolved credential. GitHubLogin is GitHub-specific and is the
// only field anything outside the launcher may read — see the Value warning.
type Token struct {
	// Value is credential material. It must never be logged, put in a prompt,
	// or returned into workflow state; see authz.Service for the discipline.
	Value       string `json:"token"`
	GitHubLogin string `json:"githubLogin,omitempty"`
	// CredentialsJSON is `/claude-auth/api/token?mode=login`'s own field name
	// for the same credential material `Value` holds for every other
	// provider/mode -- a full Claude Code login blob, not a bearer token, so
	// the gateway's response shape differs from `token`. Never populated for
	// anything except claude-remote; folded into Value below rather than
	// exposed here, since every caller of Token() reads Value regardless of
	// provider.
	CredentialsJSON string `json:"credentialsJson,omitempty"`
}

// Poll statuses for a device flow.
const (
	PollPending  = "pending"
	PollComplete = "complete"
	PollExpired  = "expired"
	PollDenied   = "denied"
)

// WritebackGrant lets a run persist a credential its own CLI refreshed in
// place. Without it, a `claude-remote` credential dies the first time the run
// rotates it and every later run reports "Login expired" (upstream ADR 0034).
type WritebackGrant struct {
	URL   string `json:"url"`
	Token string `json:"token"`
	// SecretName is the gateway-side object the grant lives in, handed to the
	// run so Kubernetes collects it with the run rather than accumulating one
	// per launch forever. Absent from an older gateway.
	SecretName string `json:"secretName,omitempty"`
}

// Port is the credential surface the authorization pre-flight depends on.
// Every method is allowed to be unimplemented by a given provider's backend;
// the pre-flight degrades rather than failing when one is.
type Port interface {
	// Start begins a link flow for (provider, subject).
	Start(ctx context.Context, provider, subject, flow string) (StartResult, error)

	// Token returns the caller's linked credential, or nil when nothing is
	// linked — a 404, not an error.
	Token(ctx context.Context, provider, subject string) (*Token, error)

	// LinkedLogin answers WHO the caller proved control of, without requiring
	// that link's access token to still be usable.
	//
	// This distinction is load-bearing, not a convenience. Reading identity
	// through Token means a link whose access token expired overnight reads as
	// "this caller has no GitHub identity" — which made upstream's pre-flight
	// offer a link the caller already had, on every single turn, while the
	// turn then succeeded 0.3s later off the same record (ADR 0031).
	LinkedLogin(ctx context.Context, provider, subject string) (string, error)

	// Poll advances a device flow.
	Poll(ctx context.Context, provider, subject, deviceCode string) (string, error)

	// Wait blocks gateway-side until a credential lands for
	// (provider, subject), or returns nil once timeout elapses.
	//
	// Called with a SHORT timeout and looped by the workflow, which is the one
	// real divergence from upstream's client. Upstream holds a single
	// multi-minute fetch for the whole flow, because its orchestrator has
	// nowhere durable to park — and that hold is acknowledged as fragile: a
	// gateway rollout, an idle intermediary, or undici's own headers timeout
	// all surface as "fetch failed" mid-wait, and ADR 0033's whole subject is
	// what happens when the process holding a wait disappears.
	//
	// Here the wait itself is durable, so the HTTP call only has to survive
	// one short hop. The gateway's watch still resolves the common case
	// instantly; the workflow's timer bounds the damage when it does not. Both
	// mechanisms, not one with the other as a fallback branch — the same
	// reasoning ADR 0034 applies to its own watch-plus-poll.
	Wait(ctx context.Context, provider, subject string, timeout time.Duration) (*Token, error)

	// Invalidate drops a stored link, so the next resolution starts fresh
	// instead of repeating a credential the run already reported as dead.
	Invalidate(ctx context.Context, provider, subject string) error

	// Rekey moves an already-authorized credential between subjects,
	// reporting whether anything moved.
	//
	// The caller MUST have established that both subjects are the same human.
	// Never call it with a subject several people resolve to.
	Rekey(ctx context.Context, provider, fromSubject, toSubject string) (bool, error)

	// WritebackGrant mints a grant for a run to persist a refreshed
	// credential. Best-effort: nil means no write-back, not an error.
	WritebackGrant(ctx context.Context, provider, subject string, ttl time.Duration) (*WritebackGrant, error)
}

// Client speaks the integration-gateway credential API.
//
// One client covers all three providers because they are all served by the
// same gateway; only the route prefix and a `mode` discriminator differ, which
// is a smaller difference than three near-identical clients (upstream has
// three, and the drift between them is where its claude-remote auto-resume bug
// lived).
type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type Options struct {
	BaseURL string
	Token   string
	// HTTPClient is injectable for tests. Note the timeout must comfortably
	// exceed a link flow's start latency — a `claude setup-token` start spawns
	// a CLI and scrapes its output.
	HTTPClient *http.Client
}

func New(opts Options) *Client {
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	return &Client{
		baseURL: strings.TrimSuffix(opts.BaseURL, "/"),
		token:   opts.Token,
		http:    httpClient,
	}
}

// claudeMode maps a provider onto the claude-auth API's `mode`, and reports
// whether this provider is served by that API at all.
func claudeMode(provider string) (mode string, isClaude bool) {
	switch provider {
	case ProviderClaude:
		return "", true // setup-token, the API's default
	case ProviderClaudeRemote:
		return "login", true
	default:
		return "", false
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) (status int, err error) {
	var reader *bytes.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, fmt.Errorf("marshal request: %w", err)
		}
		reader = bytes.NewReader(raw)
	}

	var req *http.Request
	if reader != nil {
		req, err = http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	} else {
		req, err = http.NewRequestWithContext(ctx, method, c.baseURL+path, nil)
	}
	if err != nil {
		return 0, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}

	res, err := c.http.Do(req)
	if err != nil {
		return 0, err
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusNotFound {
		return res.StatusCode, nil // "nothing linked" — expected, not an error
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		// Deliberately does NOT include the response body: an error path on a
		// credential API is the easiest place to accidentally log a token.
		return res.StatusCode, fmt.Errorf("%s %s: unexpected status %d", method, path, res.StatusCode)
	}
	if out != nil {
		if err := json.NewDecoder(res.Body).Decode(out); err != nil {
			return res.StatusCode, fmt.Errorf("decode %s response: %w", path, err)
		}
	}
	return res.StatusCode, nil
}

func (c *Client) Start(ctx context.Context, provider, subject, flow string) (StartResult, error) {
	if mode, isClaude := claudeMode(provider); isClaude {
		body := map[string]any{"subject": subject}
		if mode != "" {
			body["mode"] = mode
		}
		var out struct {
			PageURL string `json:"pageUrl"`
		}
		if _, err := c.do(ctx, http.MethodPost, "/claude-auth/api/start", body, &out); err != nil {
			return StartResult{}, err
		}
		if out.PageURL == "" {
			return StartResult{}, fmt.Errorf("claude-auth start (%s) returned no page URL", provider)
		}
		// The claude flows have no HTTP expiry of their own; the PTY holds the
		// session for ten minutes, matching upstream's constant.
		return StartResult{Flow: FlowPage, PageURL: out.PageURL, ExpiresInSeconds: 600}, nil
	}

	var out StartResult
	if _, err := c.do(ctx, http.MethodPost,
		"/identity-link/"+url.PathEscape(provider)+"/start",
		map[string]any{"subject": subject, "flow": flow}, &out); err != nil {
		return StartResult{}, err
	}
	if out.Flow == "" {
		return StartResult{}, fmt.Errorf("identity-link start (%s) returned no flow", provider)
	}
	return out, nil
}

func (c *Client) Token(ctx context.Context, provider, subject string) (*Token, error) {
	path := "/identity-link/" + url.PathEscape(provider) + "/token?subject=" + url.QueryEscape(subject)
	if mode, isClaude := claudeMode(provider); isClaude {
		path = "/claude-auth/api/token?subject=" + url.QueryEscape(subject)
		if mode != "" {
			path += "&mode=" + url.QueryEscape(mode)
		}
	}

	var out Token
	status, err := c.do(ctx, http.MethodGet, path, nil, &out)
	if err != nil {
		return nil, err
	}
	if out.Value == "" {
		out.Value = out.CredentialsJSON
	}
	if status == http.StatusNotFound || out.Value == "" {
		return nil, nil
	}
	return &out, nil
}

func (c *Client) LinkedLogin(ctx context.Context, provider, subject string) (string, error) {
	var out struct {
		GitHubLogin string `json:"githubLogin"`
	}
	status, err := c.do(ctx, http.MethodGet,
		"/identity-link/"+url.PathEscape(provider)+"/identity?subject="+url.QueryEscape(subject),
		nil, &out)
	if err != nil {
		return "", err
	}
	if status == http.StatusNotFound {
		return "", nil
	}
	return out.GitHubLogin, nil
}

func (c *Client) Poll(ctx context.Context, provider, subject, deviceCode string) (string, error) {
	var out struct {
		Status string `json:"status"`
	}
	if _, err := c.do(ctx, http.MethodPost,
		"/identity-link/"+url.PathEscape(provider)+"/poll",
		map[string]any{"subject": subject, "deviceCode": deviceCode}, &out); err != nil {
		return "", err
	}
	return out.Status, nil
}

func (c *Client) Wait(ctx context.Context, provider, subject string, timeout time.Duration) (*Token, error) {
	body := map[string]any{"subject": subject, "timeoutMs": timeout.Milliseconds()}
	path := "/identity-link/" + url.PathEscape(provider) + "/wait"
	if mode, isClaude := claudeMode(provider); isClaude {
		path = "/claude-auth/api/wait"
		if mode != "" {
			body["mode"] = mode
		}
	}

	var out struct {
		Status string `json:"status"`
		Token  *Token `json:"token"`
	}
	if _, err := c.do(ctx, http.MethodPost, path, body, &out); err != nil {
		return nil, err
	}
	if out.Status != "complete" || out.Token == nil || out.Token.Value == "" {
		return nil, nil
	}
	return out.Token, nil
}

func (c *Client) Invalidate(ctx context.Context, provider, subject string) error {
	if mode, isClaude := claudeMode(provider); isClaude {
		body := map[string]any{"subject": subject}
		if mode != "" {
			body["mode"] = mode
		}
		_, err := c.do(ctx, http.MethodPost, "/claude-auth/api/invalidate", body, nil)
		return err
	}
	// GitHub's own refresh handles its version of this gateway-side, so there
	// is deliberately no identity-link invalidate route to call.
	return nil
}

func (c *Client) Rekey(ctx context.Context, provider, fromSubject, toSubject string) (bool, error) {
	mode, isClaude := claudeMode(provider)
	if !isClaude {
		// The github link stays on the raw subject by design — it is what
		// PRODUCES the mapping, so keying it by principal would be circular.
		return false, nil
	}
	body := map[string]any{"from": fromSubject, "to": toSubject}
	if mode != "" {
		body["mode"] = mode
	}
	var out struct {
		Moved bool `json:"moved"`
	}
	if _, err := c.do(ctx, http.MethodPost, "/claude-auth/api/rekey", body, &out); err != nil {
		return false, err
	}
	return out.Moved, nil
}

func (c *Client) WritebackGrant(ctx context.Context, provider, subject string, ttl time.Duration) (*WritebackGrant, error) {
	if provider != ProviderClaudeRemote {
		return nil, nil
	}
	var out WritebackGrant
	if _, err := c.do(ctx, http.MethodPost, "/claude-auth/api/writeback-token",
		map[string]any{"subject": subject, "ttlSeconds": int(ttl.Seconds())}, &out); err != nil {
		return nil, err
	}
	if out.URL == "" || out.Token == "" {
		return nil, nil
	}
	return &out, nil
}
