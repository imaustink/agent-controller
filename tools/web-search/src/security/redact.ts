/**
 * Best-effort redaction for anything that might be surfaced in logs or error
 * messages (same convention as tools/recipe-publisher/src/security/redact.ts).
 */
const SECRET_PATTERNS: RegExp[] = [/Bearer\s+[A-Za-z0-9._-]{16,}/gi];

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  return out;
}

/** Truncate a string for safe logging. */
export function clip(input: string, max = 500): string {
  const redacted = redact(input);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}
