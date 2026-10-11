"""Reference LocalTool (ADR 0014), python runtime.

Implements the stdio ABI: read a URL from stdin, GET it (behind an SSRF guard
that rejects private/loopback/link-local/metadata addresses and disallows
redirects), and write exactly one JSON envelope to stdout. Exit 0 on success,
non-zero on failure (the executor sidecar reads the envelope either way).
"""

import ipaddress
import json
import socket
import sys
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_BODY = 100_000


def emit(envelope: dict) -> None:
    sys.stdout.write(json.dumps(envelope) + "\n")


def _is_blocked(ip: str) -> bool:
    addr = ipaddress.ip_address(ip)
    return (
        addr.is_private
        or addr.is_loopback
        or addr.is_link_local  # includes 169.254.169.254 metadata
        or addr.is_multicast
        or addr.is_reserved
        or addr.is_unspecified
    )


def assert_public(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise ValueError("only http/https URLs are allowed")
    host = parsed.hostname
    if not host:
        raise ValueError("URL has no host")
    infos = socket.getaddrinfo(host, None)
    if not infos:
        raise ValueError(f"could not resolve host {host}")
    for info in infos:
        ip = info[4][0]
        if _is_blocked(ip):
            raise ValueError(f"blocked address {ip} (SSRF guard)")


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):  # noqa: D401, ANN001, ANN002, ANN003
        # Disallow redirects so a 3xx to an internal host can't bypass the guard.
        raise ValueError("redirects are not allowed")


def main() -> None:
    data = sys.stdin.read().strip()
    if not data:
        emit({"type": "failed", "code": "usage", "message": "no URL provided on stdin"})
        sys.exit(1)
    try:
        assert_public(data)
    except Exception as exc:  # noqa: BLE001
        emit({"type": "failed", "code": "blocked_url", "message": str(exc)})
        sys.exit(1)
    try:
        opener = build_opener(_NoRedirect)
        with opener.open(Request(data), timeout=30) as resp:
            body = resp.read(MAX_BODY).decode("utf-8", "replace")
            emit({"type": "succeeded", "result": {"status": resp.status, "body": body}})
    except Exception as exc:  # noqa: BLE001
        emit({"type": "failed", "code": "http_error", "message": str(exc)})
        sys.exit(1)


if __name__ == "__main__":
    main()
