package executor

import (
	"context"
	"testing"
)

func TestResolveShellVerifiesChecksum(t *testing.T) {
	script := []byte("#!/bin/sh\necho '{\"type\":\"succeeded\",\"result\":1}'\n")
	digest := sha256Hex(script)

	t.Run("matching checksum caches and returns a Command", func(t *testing.T) {
		cfg := Config{Runtime: "shell", CacheDir: t.TempDir(), AllowedRegistryHosts: []string{"example.com"}}
		r := newResolver(cfg)
		r.httpGet = func(context.Context, string) ([]byte, error) { return script, nil }
		cmd, err := r.resolve(context.Background(), RunRequest{
			Runtime: "shell", SourceURL: "https://example.com/x.sh", Checksum: digest,
		})
		if err != nil {
			t.Fatalf("resolve: %v", err)
		}
		if cmd.Name != "sh" || len(cmd.Args) != 1 {
			t.Fatalf("unexpected command: %+v", cmd)
		}
		if !exists(cmd.Args[0]) {
			t.Fatalf("script not cached at %s", cmd.Args[0])
		}
	})

	t.Run("checksum mismatch is rejected before caching", func(t *testing.T) {
		cfg := Config{Runtime: "shell", CacheDir: t.TempDir(), AllowedRegistryHosts: []string{"example.com"}}
		r := newResolver(cfg)
		r.httpGet = func(context.Context, string) ([]byte, error) { return []byte("tampered"), nil }
		_, err := r.resolve(context.Background(), RunRequest{
			Runtime: "shell", SourceURL: "https://example.com/x.sh", Checksum: digest,
		})
		if err == nil {
			t.Fatal("expected checksum mismatch error")
		}
	})
}
