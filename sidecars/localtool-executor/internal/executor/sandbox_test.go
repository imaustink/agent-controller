package executor

import (
	"slices"
	"strings"
	"testing"
)

func TestBuildBwrapArgs(t *testing.T) {
	cfg := Config{Runtime: "node", BwrapPath: "bwrap"}
	cmd := Command{Name: "node", Args: []string{"/cache/tool/index.js"}, Dir: "/cache/tool"}

	t.Run("network denied by default", func(t *testing.T) {
		args := buildBwrapArgs(cfg, false, map[string]string{"FOO": "bar"}, cmd)
		if !slices.Contains(args, "--unshare-all") {
			t.Fatal("expected --unshare-all")
		}
		if slices.Contains(args, "--share-net") {
			t.Fatal("must NOT share net when network=false")
		}
		if !slices.Contains(args, "--clearenv") {
			t.Fatal("expected --clearenv")
		}
		assertSetenv(t, args, "FOO", "bar")
		assertSetenv(t, args, "HOME", "/tmp")
	})

	t.Run("network shared when opted in", func(t *testing.T) {
		args := buildBwrapArgs(cfg, true, nil, cmd)
		if !slices.Contains(args, "--share-net") {
			t.Fatal("expected --share-net when network=true")
		}
	})

	t.Run("command follows the -- separator", func(t *testing.T) {
		args := buildBwrapArgs(cfg, false, nil, cmd)
		sep := slices.Index(args, "--")
		if sep < 0 {
			t.Fatal("missing -- separator")
		}
		tail := args[sep+1:]
		if tail[0] != "node" || tail[1] != "/cache/tool/index.js" {
			t.Fatalf("command not at tail: %v", tail)
		}
	})

	t.Run("request env overrides command env", func(t *testing.T) {
		c := Command{Name: "x", Env: map[string]string{"K": "from-cmd"}}
		args := buildBwrapArgs(cfg, false, map[string]string{"K": "from-req"}, c)
		assertSetenv(t, args, "K", "from-req")
	})
}

// assertSetenv checks the args contain the sequence --setenv KEY VALUE.
func assertSetenv(t *testing.T, args []string, key, value string) {
	t.Helper()
	for i := 0; i+2 < len(args); i++ {
		if args[i] == "--setenv" && args[i+1] == key {
			if args[i+2] != value {
				t.Fatalf("--setenv %s = %q, want %q", key, args[i+2], value)
			}
			return
		}
	}
	t.Fatalf("no --setenv %s in %s", key, strings.Join(args, " "))
}

func TestSanitize(t *testing.T) {
	if got := sanitize("@scope/pkg"); strings.Contains(got, "/") {
		t.Fatalf("sanitize left a separator: %q", got)
	}
	if got := sanitize(".."); got == ".." {
		t.Fatalf("sanitize did not neutralize a traversal segment: %q", got)
	}
	if got := sanitize("."); got == "." {
		t.Fatalf("sanitize did not neutralize a dot segment: %q", got)
	}
	if got := lastPathSegment("example.com/x/cmd/tool"); got != "tool" {
		t.Fatalf("lastPathSegment = %q", got)
	}
}
