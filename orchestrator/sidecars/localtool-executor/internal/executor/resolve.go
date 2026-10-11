package executor

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// resolver fetches and caches a pinned package for a runtime and returns the
// Command to run it. Fetching is the highest-risk phase (npm/pip/go run
// install-time code) so it happens BEFORE the sandbox, guarded by pinning +
// checksum + registry allowlist, with install-time script execution disabled
// where the package manager allows it (npm --ignore-scripts, pip wheels-only).
//
// A per-cache-key mutex prevents two concurrent requests from installing the
// same package at once. Fetch-phase network reaches the configured registries
// only; the subsequent run phase is governed by the tool's own network policy.
type resolver struct {
	cfg   Config
	mu    sync.Mutex
	locks map[string]*sync.Mutex
	// httpGet is injectable for tests; defaults to the shared client below.
	httpGet func(ctx context.Context, url string) ([]byte, error)
}

func newResolver(cfg Config) *resolver {
	return &resolver{cfg: cfg, locks: map[string]*sync.Mutex{}, httpGet: httpGetDefault}
}

func (r *resolver) keyLock(key string) *sync.Mutex {
	r.mu.Lock()
	defer r.mu.Unlock()
	if m, ok := r.locks[key]; ok {
		return m
	}
	m := &sync.Mutex{}
	r.locks[key] = m
	return m
}

func (r *resolver) resolve(ctx context.Context, req RunRequest) (Command, error) {
	key := filepath.Join(req.Runtime, sanitize(req.Package)+"@"+sanitize(req.Version)+sanitize(req.SourceURL))
	lock := r.keyLock(key)
	lock.Lock()
	defer lock.Unlock()

	switch req.Runtime {
	case "node":
		return r.resolveNode(ctx, req)
	case "python":
		return r.resolvePython(ctx, req)
	case "go":
		return r.resolveGo(ctx, req)
	case "shell":
		return r.resolveShell(ctx, req)
	default:
		return Command{}, fmt.Errorf("unsupported runtime %q", req.Runtime)
	}
}

func (r *resolver) resolveNode(ctx context.Context, req RunRequest) (Command, error) {
	dir := filepath.Join(r.cfg.CacheDir, "node", sanitize(req.Package)+"@"+sanitize(req.Version))
	pkgDir := filepath.Join(dir, "node_modules", req.Package)
	if !exists(pkgDir) {
		if err := runInstallEnv(ctx, dir, r.installEnv(), "npm", "install", req.Package+"@"+req.Version,
			"--prefix", dir, "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"); err != nil {
			return Command{}, err
		}
	}
	entry := req.Entry
	if entry == "" {
		entry = nodeMainEntry(pkgDir)
	}
	return Command{Name: "node", Args: []string{filepath.Join(pkgDir, entry)}, Dir: dir}, nil
}

func (r *resolver) resolvePython(ctx context.Context, req RunRequest) (Command, error) {
	dir := filepath.Join(r.cfg.CacheDir, "python", sanitize(req.Package)+"@"+sanitize(req.Version))
	venvPy := filepath.Join(dir, "venv", "bin", "python")
	if !exists(venvPy) {
		if err := runInstallEnv(ctx, dir, r.installEnv(), "python3", "-m", "venv", filepath.Join(dir, "venv")); err != nil {
			return Command{}, err
		}
		if err := runInstallEnv(ctx, dir, r.installEnv(), venvPy, "-m", "pip", "install", "--only-binary=:all:",
			req.Package+"=="+req.Version); err != nil {
			return Command{}, err
		}
	}
	module := req.Entry
	if module == "" {
		module = strings.ReplaceAll(req.Package, "-", "_")
	}
	return Command{Name: venvPy, Args: []string{"-m", module}, Dir: dir}, nil
}

func (r *resolver) resolveGo(ctx context.Context, req RunRequest) (Command, error) {
	dir := filepath.Join(r.cfg.CacheDir, "go", sanitize(req.Package)+"@"+sanitize(req.Version))
	binName := req.Entry
	if binName == "" {
		binName = lastPathSegment(req.Package)
	}
	binPath := filepath.Join(dir, binName)
	if !exists(binPath) {
		if err := runInstallEnv(ctx, dir, r.installEnv("GOBIN="+dir, "GOFLAGS=-mod=mod"),
			"go", "install", req.Package+"@"+req.Version); err != nil {
			return Command{}, err
		}
	}
	return Command{Name: binPath, Dir: dir}, nil
}

func (r *resolver) resolveShell(ctx context.Context, req RunRequest) (Command, error) {
	digest := strings.TrimPrefix(req.Checksum, "sha256:")
	file := filepath.Join(r.cfg.CacheDir, "shell", digest+".sh")
	if !exists(file) {
		body, err := r.httpGet(ctx, req.SourceURL)
		if err != nil {
			return Command{}, err
		}
		if got := sha256Hex(body); got != digest {
			return Command{}, fmt.Errorf("checksum mismatch: got %s, want %s", got, digest)
		}
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			return Command{}, err
		}
		if err := os.WriteFile(file, body, 0o644); err != nil {
			return Command{}, err
		}
	}
	return Command{Name: "sh", Args: []string{file}, Dir: filepath.Dir(file)}, nil
}

// nodeMainEntry reads a package's package.json for its bin/main entrypoint,
// falling back to index.js.
func nodeMainEntry(pkgDir string) string {
	data, err := os.ReadFile(filepath.Join(pkgDir, "package.json"))
	if err != nil {
		return "index.js"
	}
	var pkg struct {
		Main string          `json:"main"`
		Bin  json.RawMessage `json:"bin"`
	}
	if err := json.Unmarshal(data, &pkg); err != nil {
		return "index.js"
	}
	// bin as a single string wins (it's the intended CLI entrypoint).
	var binStr string
	if json.Unmarshal(pkg.Bin, &binStr) == nil && binStr != "" {
		return binStr
	}
	var binMap map[string]string
	if json.Unmarshal(pkg.Bin, &binMap) == nil {
		for _, v := range binMap {
			return v
		}
	}
	if pkg.Main != "" {
		return pkg.Main
	}
	return "index.js"
}

// installEnv points every package manager's HOME/cache at the writable cache
// volume, since the sidecar's own root filesystem is read-only.
func (r *resolver) installEnv(extra ...string) []string {
	base := []string{
		"HOME=" + r.cfg.CacheDir,
		"NPM_CONFIG_CACHE=" + filepath.Join(r.cfg.CacheDir, ".npm"),
		"PIP_CACHE_DIR=" + filepath.Join(r.cfg.CacheDir, ".pip"),
		"GOPATH=" + filepath.Join(r.cfg.CacheDir, "go-path"),
		"GOCACHE=" + filepath.Join(r.cfg.CacheDir, ".gocache"),
		"GOMODCACHE=" + filepath.Join(r.cfg.CacheDir, "go-path", "pkg", "mod"),
	}
	return append(base, extra...)
}

func runInstallEnv(ctx context.Context, dir string, extraEnv []string, name string, args ...string) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	c := exec.CommandContext(ctx, name, args...)
	c.Dir = dir
	c.Env = append(os.Environ(), extraEnv...)
	out, err := c.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %s: %w: %s", name, strings.Join(args, " "), err, truncate(string(out), 500))
	}
	return nil
}

func httpGetDefault(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("GET %s returned %d", url, resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, 16<<20))
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// sanitize keeps a cache path component filesystem-safe (no traversal).
func sanitize(s string) string {
	mapped := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			return r
		case r == '.' || r == '-' || r == '_':
			return r
		default:
			return '_'
		}
	}, s)
	// A component of exactly "." or ".." would traverse when path-joined even
	// though it contains no separator — neutralize it.
	if mapped == "." || mapped == ".." {
		return "_"
	}
	return mapped
}

// lastPathSegment returns the final "/"-separated element of a module path,
// used as the default Go binary name (e.g. example.com/x/cmd/tool -> "tool").
func lastPathSegment(p string) string {
	if i := strings.LastIndex(p, "/"); i >= 0 {
		return p[i+1:]
	}
	return p
}
