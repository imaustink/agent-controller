package corpus

import (
	"context"
	"errors"
	"sort"
	"sync"
)

// Granularity is the unit a provider authorizes at (ADR 0040).
//
// It differs per provider and is not a wrinkle to work around. Confluence and
// Drive authorize a page or a file; Slack authorizes a CHANNEL, because
// membership is the access unit and there is no per-message permission to
// check. A per-connection provider therefore settles every candidate from that
// connection with one probe, which is cheaper than the per-resource case rather
// than harder.
type Granularity string

const (
	GranularityResource   Granularity = "resource"
	GranularityConnection Granularity = "connection"
)

// ProbeRequest identifies what to authorize. SourceID is empty for a
// connection-granularity provider.
type ProbeRequest struct {
	CorpusID string
	SourceID     string
}

// ProbeResult is the source's answer, and the ONLY acceptable origin for
// anything displayable.
//
// Title and URL come back here rather than from the mirror because citations
// are content (ADR 0040): an answer that cites a page title the user may not
// read has disclosed the thing while appearing to have returned nothing.
type ProbeResult struct {
	Allowed bool
	Title   string
	URL     string
	// Version the source holds right now. A mismatch against the indexed chunk
	// means the passage is stale, which the answer may still use — while saying
	// so — or replace by fetching the live document.
	Version string
}

// Prober asks the source, as the calling user, whether a resource is readable.
//
// Implementations MUST distinguish error classes (ADR 0040): a permission
// failure is a drop, and anything else is not. Returning a transient failure as
// a denial makes the same question return different evidence depending on
// whether the source was busy.
type Prober interface {
	Granularity(connectionID string) Granularity
	Probe(ctx context.Context, req ProbeRequest) (ProbeResult, error)
}

// PermissionDenied means the source says this user may not read it. Drop.
type PermissionDenied struct{ Err error }

func (e *PermissionDenied) Error() string { return "permission denied: " + e.Err.Error() }
func (e *PermissionDenied) Unwrap() error { return e.Err }

// Transient means we could not find out — a 429, a 5xx, a timeout.
//
// Deliberately NOT a denial. Treating it as one silently shrinks an answer in a
// way nobody can see, and makes results non-deterministic across retries.
type Transient struct{ Err error }

func (e *Transient) Error() string { return "transient probe failure: " + e.Err.Error() }
func (e *Transient) Unwrap() error { return e.Err }

// AuthorizedChunk is a candidate the source confirmed this user may read.
//
// Title and URL shadow anything the chunk carried: they are the probe's, not
// the mirror's.
type AuthorizedChunk struct {
	Chunk   Chunk
	Score   float32
	Title   string
	URL     string
	Version string
	// Stale means the source has moved past the indexed version. The passage is
	// still readable by this user, so it is not dropped — but an answer built on
	// it should say how old it is, or fetch the live document instead.
	Stale bool
}

// AuthorizeOutcome is what survived, plus what did not and why.
type AuthorizeOutcome struct {
	Chunks []AuthorizedChunk
	// Denied is how many candidates the source refused. Expected and harmless:
	// it measures the mirror's staleness in the permissive direction.
	Denied int
	// Undetermined names sources whose probe failed transiently. These are NOT
	// dropped silently — the caller surfaces them as a partial-results warning,
	// because an answer quietly missing evidence is worse than one that admits
	// it could not check.
	Undetermined []string
}

// Authorize is the gate between candidate retrieval and anything the model
// sees (ADR 0040).
//
// The mirror got us a short list; this is where the source decides. Every
// surviving chunk was confirmed readable, at query time, by the source system
// itself under this user's own credentials.
//
// Probes are deduplicated before they are issued — by connection for a
// connection-granularity provider, by source otherwise — so eight chunks from
// one page cost one probe, not eight. That deduplication is most of why this
// step is affordable.
func Authorize(ctx context.Context, prober Prober, hits []Hit) (AuthorizeOutcome, error) {
	if len(hits) == 0 {
		return AuthorizeOutcome{}, nil
	}

	requests := map[ProbeRequest]struct{}{}
	keyFor := func(chunk Chunk) ProbeRequest {
		if prober.Granularity(chunk.CorpusID) == GranularityConnection {
			return ProbeRequest{CorpusID: chunk.CorpusID}
		}
		return ProbeRequest{CorpusID: chunk.CorpusID, SourceID: chunk.SourceID}
	}
	for _, hit := range hits {
		requests[keyFor(hit.Chunk)] = struct{}{}
	}

	type probeOutcome struct {
		result ProbeResult
		err    error
	}
	var (
		mu       sync.Mutex
		results  = make(map[ProbeRequest]probeOutcome, len(requests))
		wg       sync.WaitGroup
		fatalErr error
	)

	for req := range requests {
		wg.Add(1)
		go func(req ProbeRequest) {
			defer wg.Done()
			result, err := prober.Probe(ctx, req)

			mu.Lock()
			defer mu.Unlock()
			results[req] = probeOutcome{result: result, err: err}

			// An error that is neither a denial nor transient is a programming
			// error in the driver, not an authorization answer. Failing the
			// whole search is correct: guessing which it meant is how a leak
			// gets introduced.
			var denied *PermissionDenied
			var transient *Transient
			if err != nil && !errors.As(err, &denied) && !errors.As(err, &transient) && fatalErr == nil {
				fatalErr = err
			}
		}(req)
	}
	wg.Wait()

	if fatalErr != nil {
		return AuthorizeOutcome{}, fatalErr
	}

	outcome := AuthorizeOutcome{Chunks: make([]AuthorizedChunk, 0, len(hits))}
	undetermined := map[string]struct{}{}

	for _, hit := range hits {
		probe := results[keyFor(hit.Chunk)]

		var transient *Transient
		if errors.As(probe.err, &transient) {
			undetermined[hit.Chunk.CorpusID+"/"+hit.Chunk.SourceID] = struct{}{}
			continue
		}
		var denied *PermissionDenied
		if errors.As(probe.err, &denied) || !probe.result.Allowed {
			outcome.Denied++
			continue
		}

		outcome.Chunks = append(outcome.Chunks, AuthorizedChunk{
			Chunk:   hit.Chunk,
			Score:   hit.Score,
			Title:   probe.result.Title,
			URL:     probe.result.URL,
			Version: probe.result.Version,
			// An empty probe version means the provider does not report one; a
			// chunk cannot then be shown to be stale, so it is not claimed to be.
			Stale: probe.result.Version != "" && probe.result.Version != hit.Chunk.Version,
		})
	}

	for source := range undetermined {
		outcome.Undetermined = append(outcome.Undetermined, source)
	}
	sort.Strings(outcome.Undetermined)
	return outcome, nil
}
