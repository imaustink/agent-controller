/**
 * Best-effort redaction for anything that might be surfaced in logs or error
 * messages. This tool ingests untrusted page content, so we never want a
 * stray secret (or a huge injected blob) leaking into the parent agent's logs
 * (same convention as tools/recipe-scraper/src/security/redact.ts).
 */
const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI-style keys
  /Bearer\s+[A-Za-z0-9._-]{16,}/gi,
];

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
