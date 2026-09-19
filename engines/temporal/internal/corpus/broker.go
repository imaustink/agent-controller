package corpus

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultCandidateMultiplier is how far retrieval over-fetches before probing.
//
// Hydration drops candidates, so asking for exactly the context window's worth
// would leave the answer starved whenever the mirror was optimistic. ADR 0040
// says start at 3x and tune from observed drop rates; the right value is an
// operational question, which is why this is a starting point rather than a
// constant nobody revisits.
const DefaultCandidateMultiplier = 3

// BrokerProber asks the connection-broker whether the calling user may read a
// resource (ADR 0040).
//
// The orchestrator deliberately holds no third-party credential of its own: it
// forwards the user's delegated token per request and the broker refuses to let
// it spend a connection's service credential at all (the broker's auth.ts).
// So this type carries a token it did not mint and cannot widen.
type BrokerProber struct {
	// BaseURL of the connection-broker Service.
	BaseURL string
	// Token authenticating THIS orchestrator to the broker — distinct from the
	// per-user delegated token below, which authenticates the user to the
	// source.
	Token string
	// DelegatedToken is the calling user's own credential, resolved per turn.
	DelegatedToken string
	// Granularities maps a connection to the unit its provider authorizes at,
	// taken from the catalog rather than guessed.
	Granularities map[string]Granularity

	HTTPClient *http.Client
}

func (b *BrokerProber) Granularity(connectionID string) Granularity {
	if g, ok := b.Granularities[connectionID]; ok {
		return g
	}
	// An unknown provider is probed per resource: the finer unit is the safe
	// default, since assuming per-connection would let one allowed resource
	// vouch for every other candidate from that source.
	return GranularityResource
}

func (b *BrokerProber) Probe(ctx context.Context, req ProbeRequest) (ProbeResult, error) {
	if b.DelegatedToken == "" {
		// Probing without the user's own credential cannot answer the question
		// being asked, and the broker would refuse it anyway.
		return ProbeResult{}, &PermissionDenied{Err: fmt.Errorf("no delegated credential for this caller")}
	}

	body, err := json.Marshal(map[string]string{"sourceId": req.SourceID})
	if err != nil {
		return ProbeResult{}, err
	}

	endpoint := strings.TrimRight(b.BaseURL, "/") + "/connections/" + url.PathEscape(req.ConnectionID) + "/probe"
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return ProbeResult{}, err
	}
	httpReq.Header.Set("content-type", "application/json")
	httpReq.Header.Set("authorization", "Bearer "+b.Token)
	httpReq.Header.Set("x-delegated-token", b.DelegatedToken)

	client := b.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Second}
	}

	resp, err := client.Do(httpReq)
	if err != nil {
		// Could not reach the broker. NOT a denial: treating it as one would
		// quietly shrink the answer and make the same question return different
		// evidence on a retry (ADR 0040).
		return ProbeResult{}, &Transient{Err: err}
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusOK:
		var result ProbeResult
		if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
			return ProbeResult{}, &Transient{Err: fmt.Errorf("decode probe response: %w", err)}
		}
		return result, nil

	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusNotFound:
		return ProbeResult{}, &PermissionDenied{Err: fmt.Errorf("broker returned %d", resp.StatusCode)}

	default:
		// Everything else — 429, 5xx, a broker that is unwell — is "we could
		// not find out", which the caller surfaces rather than swallows.
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return ProbeResult{}, &Transient{
			Err: fmt.Errorf("broker returned %d: %s", resp.StatusCode, strings.TrimSpace(string(detail))),
		}
	}
}

// RetrieveOutcome is what an answer may use, plus what it must admit.
type RetrieveOutcome struct {
	Chunks []AuthorizedChunk
	// Denied is how many candidates the source refused — expected, and a
	// measure of the mirror's optimism rather than a problem.
	Denied int
	// Undetermined names sources whose probe failed transiently, and
	// SkippedCorpora counts member collections that could not be searched at
	// all. Both are surfaced because an answer quietly missing evidence is
	// worse than one that admits it could not check.
	Undetermined   []string
	SkippedCorpora int
}
