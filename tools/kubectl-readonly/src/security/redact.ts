/**
 * Best-effort redaction for anything that might be surfaced in progress/error
 * messages. kubectl error text can echo the auth flags we passed it, so any
 * bearer token or certificate material is stripped before it leaves this
 * process.
 */
const SECRET_PATTERNS: RegExp[] = [
  /--token=\S+/g,
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
  /eyJ[A-Za-z0-9._-]{20,}/g, // JWT-shaped (k8s SA tokens are JWTs)
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
