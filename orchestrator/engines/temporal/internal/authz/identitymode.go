package authz

import (
	"fmt"

	"github.com/aktisai/orchestrator/engines/temporal/internal/identitylink"
)

// IdentityMode is the identity an agent run acts as on the external systems
// its resource providers reach (docs/adr/0049).
type IdentityMode string

const (
	// ModeAgent: the agent's own credential (the GitHub App) for reads and
	// writes. No resource provider is resolved for the caller.
	ModeAgent IdentityMode = "agent"
	// ModeDelegated: the caller's own linked credential for reads and writes.
	ModeDelegated IdentityMode = "delegated"
	// ModeHybrid: the caller's credential for reads, the agent's for writes
	// (docs/adr/0041).
	ModeHybrid IdentityMode = "hybrid"
)

// ModeSource says where a requested mode came from.
type ModeSource string

const (
	// SourceTrigger: the EventTrigger's target.identity override.
	SourceTrigger ModeSource = "trigger"
	// SourceDefault: the Agent's defaultIdentity.
	SourceDefault ModeSource = "default"
	// SourceInferred: neither was set, so the pre-0049 behaviour was
	// inferred from the declared providers.
	SourceInferred ModeSource = "inferred"
)

// usesCaller reports whether a mode reads with the caller's credential.
func (m IdentityMode) usesCaller() bool { return m == ModeDelegated || m == ModeHybrid }

// RuntimeProviders are the model credential, not access to a system the agent
// acts on. Identity mode does not apply to them: they resolve the same way in
// every mode (docs/adr/0049 §1). Everything else is a resource provider.
//
// A fixed set rather than IdentityProvider CR data because this engine does
// not watch IdentityProvider CRs at all: ProviderEnvVar is fixed too.
var RuntimeProviders = map[string]bool{
	identitylink.ProviderClaude:       true,
	identitylink.ProviderClaudeRemote: true,
}

// WriteCapableProviders resolve a credential that can write to the system it
// reaches, so a read-only run withholds it (suppressWriteCredentials).
var WriteCapableProviders = map[string]bool{
	identitylink.ProviderGitHub: true,
}

func parseMode(raw string) (IdentityMode, bool) {
	switch m := IdentityMode(raw); m {
	case ModeAgent, ModeDelegated, ModeHybrid:
		return m, true
	}
	return "", false
}

func resourceProviders(providers []string) []string {
	var out []string
	for _, p := range providers {
		if !RuntimeProviders[p] {
			out = append(out, p)
		}
	}
	return out
}

// ModeDecision is the resolved identity mode for one launch.
type ModeDecision struct {
	// Requested is what the trigger, the Agent, or inference asked for.
	Requested IdentityMode
	Source    ModeSource
}

// ResolveMode decides the identity mode a launch requests:
//
//	override (the trigger's) ?? agent.defaultIdentity ?? inferred
//
// and checks it against allowedIdentities. An error is a misconfiguration:
// nothing about the caller could fix it.
//
// Inference reproduces exactly what ran before ADR 0049: an agent that
// declares github delegated its reads (hybrid), any other agent ran as itself.
func ResolveMode(override, defaultIdentity string, allowed, providers []string) (ModeDecision, error) {
	var d ModeDecision
	switch {
	case override != "":
		m, ok := parseMode(override)
		if !ok {
			return d, fmt.Errorf("the trigger's identity %q is not one of agent, delegated, hybrid", override)
		}
		d = ModeDecision{Requested: m, Source: SourceTrigger}
	case defaultIdentity != "":
		m, ok := parseMode(defaultIdentity)
		if !ok {
			return d, fmt.Errorf("defaultIdentity %q is not one of agent, delegated, hybrid", defaultIdentity)
		}
		d = ModeDecision{Requested: m, Source: SourceDefault}
	default:
		d = ModeDecision{Requested: ModeAgent, Source: SourceInferred}
		if containsString(providers, identitylink.ProviderGitHub) {
			d.Requested = ModeHybrid
		}
	}

	// allowedIdentities bounds what a trigger may pick. The Agent's own
	// default is held to it too (the CRD's CEL rule says the same thing); an
	// inferred mode is not, since nobody chose it.
	if d.Source != SourceInferred && len(allowed) > 0 && !containsString(allowed, string(d.Requested)) {
		return d, fmt.Errorf("identity %q (from the %s) is not in the agent's allowedIdentities %v", d.Requested, d.Source, allowed)
	}

	// A mode that acts as the caller needs something to act as the caller ON.
	if d.Requested.usesCaller() && len(resourceProviders(providers)) == 0 {
		return d, fmt.Errorf("identity %q needs a resource identity provider (e.g. github) declared on the agent", d.Requested)
	}
	return d, nil
}

// LaunchCredential records whose credential a provider's reads and writes use.
// Mirrors AgentRun.spec.launch.credentials.
type LaunchCredential struct {
	Provider string `json:"provider"`
	// Read is "caller" or "agent".
	Read string `json:"read,omitempty"`
	// Write is "caller", "agent", or "none".
	Write string `json:"write,omitempty"`
}

// launchCredentials describes, per declared provider, whose credential the run
// reads and writes with under the mode it was actually given.
func launchCredentials(providers []string, run IdentityMode, readOnly bool) []LaunchCredential {
	var out []LaunchCredential
	for _, p := range providers {
		if RuntimeProviders[p] {
			out = append(out, LaunchCredential{Provider: p, Read: "caller"})
			continue
		}
		c := LaunchCredential{Provider: p}
		switch run {
		case ModeDelegated:
			c.Read, c.Write = "caller", "caller"
		case ModeHybrid:
			c.Read, c.Write = "caller", "agent"
		default:
			c.Read, c.Write = "agent", "agent"
		}
		if readOnly {
			c.Write = "none"
		}
		out = append(out, c)
	}
	return out
}
