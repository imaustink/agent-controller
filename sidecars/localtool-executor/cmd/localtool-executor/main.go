// Command localtool-executor is the per-language LocalTool executor sidecar
// (ADR 0014). It listens on a pod-local unix socket and runs pinned, sandboxed
// tools fetched from a language registry. One image per runtime — behavior is
// selected entirely by env (LOCALTOOL_RUNTIME).
package main

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/recipe-agent/localtool-executor/internal/executor"
)

func main() {
	runtime := mustEnv("LOCALTOOL_RUNTIME")
	socketDir := envOr("LOCALTOOL_SOCKET_DIR", "/run/localtool")
	socketPath := envOr("LOCALTOOL_SOCKET", filepath.Join(socketDir, runtime+".sock"))

	cfg := executor.Config{
		Runtime:               runtime,
		SocketPath:            socketPath,
		CacheDir:              envOr("LOCALTOOL_CACHE_DIR", "/var/cache/localtool"),
		AllowedRegistryHosts:  splitList(os.Getenv("LOCALTOOL_ALLOWED_REGISTRY_HOSTS")),
		BwrapPath:             envOr("LOCALTOOL_BWRAP", "bwrap"),
		DefaultTimeoutSeconds: envInt("LOCALTOOL_DEFAULT_TIMEOUT_SECONDS", 30),
	}

	// Remove a stale socket from a previous crash so Listen doesn't fail.
	_ = os.Remove(socketPath)
	if err := os.MkdirAll(filepath.Dir(socketPath), 0o755); err != nil {
		log.Fatalf("create socket dir: %v", err)
	}
	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatalf("listen on %s: %v", socketPath, err)
	}

	srv := &http.Server{Handler: executor.NewServer(cfg).Handler(), ReadHeaderTimeout: 10 * time.Second}

	go func() {
		log.Printf("localtool-executor[%s] listening on %s", runtime, socketPath)
		if err := srv.Serve(listener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("serve: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	_ = os.Remove(socketPath)
}

func mustEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		log.Fatalf("%s is required", key)
	}
	return v
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return fallback
}

func splitList(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if t := strings.TrimSpace(p); t != "" {
			out = append(out, t)
		}
	}
	return out
}
