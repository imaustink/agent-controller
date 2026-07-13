package executor

import (
	"bytes"
	"context"
	"os/exec"
	"sort"
	"strings"
	"time"
)

// Command is a resolved, ready-to-run tool invocation (after fetch/cache).
type Command struct {
	Name string            // executable, e.g. "node", "python", "sh", or a go binary path
	Args []string          // arguments (script/module/binary + tool flags)
	Dir  string            // working directory (defaults to /tmp in the sandbox)
	Env  map[string]string // runtime-specific env additions (merged under the request env)
}

// buildBwrapArgs assembles the bubblewrap argv that wraps a tool invocation
// (ADR 0014). Pure/deterministic so it can be unit-tested without bwrap:
//   - --unshare-all: new user/ipc/pid/uts/cgroup/net namespaces (needs
//     unprivileged user namespaces on the node — a documented prerequisite).
//   - --share-net is added ONLY when the tool opted into network; otherwise the
//     unshared net namespace enforces default-deny egress.
//   - --clearenv + explicit --setenv: the tool sees ONLY its declared env
//     (plus HOME=/tmp), never the sidecar's or orchestrator's environment.
//   - read-only root + tmpfs /tmp: no filesystem writes outside scratch.
func buildBwrapArgs(cfg Config, network bool, env map[string]string, cmd Command) []string {
	dir := cmd.Dir
	if dir == "" {
		dir = "/tmp"
	}
	args := []string{
		"--unshare-all",
		"--die-with-parent",
		"--new-session",
		"--clearenv",
		"--ro-bind", "/", "/",
		"--tmpfs", "/tmp",
		"--proc", "/proc",
		"--dev", "/dev",
		"--chdir", dir,
	}
	if network {
		args = append(args, "--share-net")
	}

	merged := map[string]string{"HOME": "/tmp"}
	for k, v := range cmd.Env {
		merged[k] = v
	}
	for k, v := range env {
		merged[k] = v
	}
	keys := make([]string, 0, len(merged))
	for k := range merged {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		args = append(args, "--setenv", k, merged[k])
	}

	args = append(args, "--", cmd.Name)
	args = append(args, cmd.Args...)
	return args
}

// runSandboxed executes cmd under bubblewrap with the given input on stdin and
// a wall-clock timeout, returning the tool's stdout envelope (or a structured
// failure). Never returns an error — every failure mode maps to a failed
// Envelope so the orchestrator always gets a well-formed reply.
func runSandboxed(ctx context.Context, cfg Config, req RunRequest, cmd Command) Envelope {
	timeout := req.TimeoutSeconds
	if timeout <= 0 {
		timeout = cfg.DefaultTimeoutSeconds
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	args := buildBwrapArgs(cfg, req.Network, req.Env, cmd)
	c := exec.CommandContext(runCtx, cfg.BwrapPath, args...)
	c.Stdin = strings.NewReader(req.Input)
	var stdout, stderr bytes.Buffer
	c.Stdout = &stdout
	c.Stderr = &stderr

	err := c.Run()
	if runCtx.Err() == context.DeadlineExceeded {
		return failedEnvelope("timeout", "tool exceeded its time limit and was killed")
	}
	// A non-zero exit is a tool failure by the ABI — but the tool may still have
	// emitted a valid `failed` envelope on stdout, which is more informative
	// than the raw exit error. Prefer a parsed envelope when present.
	if env, ok := extractEnvelope(stdout.Bytes()); ok {
		return env
	}
	if err != nil {
		return failedEnvelope("exec_error", truncate(stderr.String(), 500))
	}
	return extractEnvelopeOrFail(stdout.Bytes())
}

func truncate(s string, n int) string {
	s = strings.TrimSpace(s)
	if len(s) <= n {
		return s
	}
	return s[:n]
}
