/**
 * Best-effort redaction for anything that might be surfaced in logs, error
 * messages, or forwarded Claude Code output (same convention as the other
 * tools in this repo). This agent handles unusually sensitive material -- a
 * GitHub App private key, GitHub tokens, an Anthropic API key, and a Claude
 * Code OAuth token -- so the pattern set is broader than recipe-publisher's.
 */
const SECRET_PATTERNS: RegExp[] = [
  // PEM private keys (the GitHub App key), including the BEGIN/END envelope.
  /-----BEGIN[^-]*PRIVATE KEY-----[\s\S]*?-----END[^-]*PRIVATE KEY-----/g,
  // GitHub tokens: PATs, fine-grained PATs, and installation/OAuth tokens.
  /gh[opsu]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  // Compact JWTs (the App JWT used to mint installation tokens).
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // x-access-token:<token> as embedded in an authenticated clone/push URL.
  /x-access-token:[^@\s/]+/gi,
  // Claude Code long-lived OAuth tokens (from `claude setup-token`).
  /sk-ant-oat01-[A-Za-z0-9_-]{16,}/g,
  // Anthropic API keys.
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  // Generic OpenAI-style keys and Bearer headers.
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Truncate a string for safe logging/emitting, after redacting secrets. */
export function clip(input: string, max = 500): string {
  const redacted = redact(input);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}
