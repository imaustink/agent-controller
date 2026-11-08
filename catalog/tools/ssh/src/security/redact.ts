/**
 * Best-effort redaction for anything that might be surfaced in progress/error
 * messages. ssh error text can echo the identity file path or leak key
 * material in verbose failure modes, so anything key-shaped is stripped
 * before it leaves this process.
 */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]*?-----END [A-Z ]+PRIVATE KEY-----/g,
  /identity file \S+/gi,
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
