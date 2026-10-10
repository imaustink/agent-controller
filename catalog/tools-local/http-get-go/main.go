// Command http-get is a reference LocalTool (ADR 0014), go runtime. It reads a
// URL from stdin, GETs it (behind an SSRF guard that rejects
// private/loopback/link-local/metadata addresses and disallows redirects), and
// writes exactly one stdio-ABI JSON envelope to stdout. Exit 0 on success,
// non-zero on failure (the executor sidecar reads the envelope either way).
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxBody = 100_000

type envelope struct {
	Type    string `json:"type"`
	Result  any    `json:"result,omitempty"`
	Code    string `json:"code,omitempty"`
	Message string `json:"message,omitempty"`
}

func emit(e envelope) {
	b, _ := json.Marshal(e)
	fmt.Fprintln(os.Stdout, string(b))
}

func fail(code, message string) {
	emit(envelope{Type: "failed", Code: code, Message: message})
	os.Exit(1)
}

func assertPublic(raw string) error {
	u, err := url.Parse(raw)
	if err != nil {
		return errors.New("invalid URL")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return errors.New("only http/https URLs are allowed")
	}
	host := u.Hostname()
	if host == "" {
		return errors.New("URL has no host")
	}
	ips, err := net.LookupIP(host)
	if err != nil || len(ips) == 0 {
		return fmt.Errorf("could not resolve host %s", host)
	}
	for _, ip := range ips {
		if isBlocked(ip) {
			return fmt.Errorf("blocked address %s (SSRF guard)", ip)
		}
	}
	return nil
}

func isBlocked(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsPrivate() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	// CGNAT 100.64.0.0/10.
	if v4 := ip.To4(); v4 != nil && v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 {
		return true
	}
	return false
}

func main() {
	data, err := io.ReadAll(io.LimitReader(os.Stdin, 1<<20))
	if err != nil {
		fail("usage", "could not read stdin")
	}
	raw := strings.TrimSpace(string(data))
	if raw == "" {
		fail("usage", "no URL provided on stdin")
	}
	if err := assertPublic(raw); err != nil {
		fail("blocked_url", err.Error())
	}

	client := &http.Client{
		Timeout: 30 * time.Second,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not allowed")
		},
	}
	resp, err := client.Get(raw)
	if err != nil {
		fail("http_error", err.Error())
	}
	defer func() { _ = resp.Body.Close() }()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	emit(envelope{Type: "succeeded", Result: map[string]any{"status": resp.StatusCode, "body": string(body)}})
}
