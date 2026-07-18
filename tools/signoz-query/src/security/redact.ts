/**
 * Best-effort redaction for anything that might be surfaced in progress/error
 * messages -- e.g. a SigNoz error response echoing back a header it rejected.
 */
const SECRET_PATTERNS: RegExp[] = [/Bearer\s+[A-Za-z0-9._-]{16,}/gi, /SIGNOZ-API-KEY:\s*\S+/gi];

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
