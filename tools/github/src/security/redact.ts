/**
 * Best-effort redaction for anything that might be surfaced in progress/error
 * messages. `gh`'s own error text can echo the token it was given (e.g. in a
 * verbose auth failure), so it is stripped before it ever leaves this
 * process -- same discipline as every other tool in this repo (see
 * docs/security.md's "Secret handling" section).
 */
const SECRET_PATTERNS: RegExp[] = [
  // GitHub's own token prefixes: ghp_ (PAT), gho_ (OAuth), ghu_ (user-to-server
  // App), ghs_ (server-to-server App installation), ghr_ (refresh token).
  /gh[opsu]_[A-Za-z0-9]{20,}/g,
  /ghr_[A-Za-z0-9]{20,}/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /token\s+[A-Za-z0-9._-]{16,}/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Truncate a string for safe logging. */
export function clip(input: string, max = 4000): string {
  const redacted = redact(input);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}
