/**
 * Best-effort redaction for anything that might be surfaced in progress/error
 * messages. Glyph's own API error text can echo back part of a request (and a
 * bearer token is an opaque string with no distinctive prefix to key on), so
 * generic `Bearer`/`token ` credential patterns are stripped before anything
 * leaves this process — same discipline as every other tool in this repo (see
 * docs/security.md's "Secret handling" section and tools/github/src/security/
 * redact.ts).
 */
const SECRET_PATTERNS: RegExp[] = [
  /Bearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /token\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Redact, then truncate a string for safe logging. */
export function clip(input: string, max = 4000): string {
  const redacted = redact(input);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}
