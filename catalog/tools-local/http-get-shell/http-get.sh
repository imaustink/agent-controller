#!/bin/sh
# Reference LocalTool (ADR 0014), shell runtime. Reads a URL from stdin, GETs it
# (behind a best-effort host guard + curl --proto restriction; the sandbox's
# unshared network namespace is the real egress control), and writes exactly one
# stdio-ABI JSON envelope to stdout. Requires curl + jq (present in the shell
# executor sidecar image). Exit 0 on success, non-zero on failure.
set -eu

fail() {
  jq -cn --arg code "$1" --arg message "$2" '{type:"failed",code:$code,message:$message}'
  exit 1
}

read -r url || fail usage "no URL provided on stdin"
[ -n "${url:-}" ] || fail usage "no URL provided on stdin"

case "$url" in
  http://* | https://*) ;;
  *) fail blocked_url "only http/https URLs are allowed" ;;
esac

# Best-effort hostname guard (defense in depth; netns enforces the real policy).
host=$(printf '%s' "$url" | sed -E 's#^https?://([^/:]+).*#\1#')
case "$host" in
  169.254.* | 127.* | 10.* | 192.168.* | 172.1[6-9].* | 172.2[0-9].* | 172.3[0-1].* | localhost | 0.0.0.0 | "[::1]" | ::1)
    fail blocked_url "blocked host $host (SSRF guard)"
    ;;
esac

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT

code=$(curl -sS --max-time 30 --proto '=http,https' --location-trusted --max-redirs 0 \
  -o "$tmp" -w '%{http_code}' -- "$url") || fail http_error "request failed"

body=$(head -c 100000 "$tmp")
jq -cn --arg body "$body" --argjson status "${code:-0}" \
  '{type:"succeeded",result:{status:$status,body:$body}}'
