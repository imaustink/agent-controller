package executor

import "testing"

func TestValidateRequest(t *testing.T) {
	cfg := Config{Runtime: "node", AllowedRegistryHosts: []string{"example.com"}}
	shellCfg := Config{Runtime: "shell", AllowedRegistryHosts: []string{"example.com"}}
	sha := "0000000000000000000000000000000000000000000000000000000000000000"

	cases := []struct {
		name  string
		cfg   Config
		req   RunRequest
		valid bool
	}{
		{"node pinned", cfg, RunRequest{Runtime: "node", Package: "p", Version: "1.2.3"}, true},
		{"runtime mismatch", cfg, RunRequest{Runtime: "python", Package: "p", Version: "1.2.3"}, false},
		{"node missing version", cfg, RunRequest{Runtime: "node", Package: "p"}, false},
		{"node caret range", cfg, RunRequest{Runtime: "node", Package: "p", Version: "^1.0.0"}, false},
		{"node latest", cfg, RunRequest{Runtime: "node", Package: "p", Version: "latest"}, false},
		{"shell ok", shellCfg, RunRequest{Runtime: "shell", SourceURL: "https://example.com/x.sh", Checksum: sha}, true},
		{"shell missing checksum", shellCfg, RunRequest{Runtime: "shell", SourceURL: "https://example.com/x.sh"}, false},
		{"shell http", shellCfg, RunRequest{Runtime: "shell", SourceURL: "http://example.com/x.sh", Checksum: sha}, false},
		{"shell host not allowed", shellCfg, RunRequest{Runtime: "shell", SourceURL: "https://evil.com/x.sh", Checksum: sha}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reason := tc.cfg.validateRequest(tc.req)
			if (reason == "") != tc.valid {
				t.Fatalf("validateRequest() reason=%q, want valid=%v", reason, tc.valid)
			}
		})
	}
}

func TestAllowedHost(t *testing.T) {
	_, reason := allowedHost("https://example.com/a.sh", []string{"example.com"})
	if reason != "" {
		t.Fatalf("expected allowed, got %q", reason)
	}
	if _, reason := allowedHost("https://other.com/a.sh", []string{"example.com"}); reason == "" {
		t.Fatal("expected host rejection")
	}
	if _, reason := allowedHost("https://x.com/a.sh", nil); reason == "" {
		t.Fatal("empty allowlist must deny all")
	}
}
