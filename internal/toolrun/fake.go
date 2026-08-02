package toolrun

import (
	"context"
	"log"
	"sync"
)

// FakeLauncher is the cluster-less dev mode (TOOLRUN_MODE=fake): it records
// launches and logs how to play the tool's part by hand with signed
// callbacks. Never for production — nothing actually runs.
type FakeLauncher struct {
	mu       sync.Mutex
	launched map[string]LaunchSpec
}

func NewFakeLauncher() *FakeLauncher {
	return &FakeLauncher{launched: map[string]LaunchSpec{}}
}

func (l *FakeLauncher) Launch(_ context.Context, spec LaunchSpec) error {
	l.mu.Lock()
	l.launched[spec.Name] = spec
	l.mu.Unlock()
	log.Printf("[fake toolrun] %q launched: tool=%s args=%v secretEnv=%v — post signed events to %s",
		spec.Name, spec.ToolRef, spec.Args, secretEnvNames(spec.SecretEnv), spec.CallbackURL)
	return nil
}

// secretEnvNames logs which credentials a launch carries without logging what
// they point at. Even a Secret name/key pair is a hint about where a
// credential lives, and the same discipline upstream applies to its own debug
// lines (env var NAMES only, never values) is cheaper to keep than to restore.
func secretEnvNames(env []SecretEnvVar) []string {
	if len(env) == 0 {
		return nil
	}
	names := make([]string, len(env))
	for i, e := range env {
		names[i] = e.Name
	}
	return names
}

func (l *FakeLauncher) GetStatus(_ context.Context, name string) (Status, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if _, ok := l.launched[name]; ok {
		return Status{Phase: PhaseRunning, Message: "fake launcher: no job exists"}, nil
	}
	return Status{Message: "ToolRun not found"}, nil
}
