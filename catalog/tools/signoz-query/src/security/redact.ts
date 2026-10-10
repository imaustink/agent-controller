/**
 * Best-effort redaction for anything that might be surfaced in progress/error
 * messages -- e.g. a SigNoz error response echoing back a header it rejected.
 */
const SECRET_PATTERNS: RegExp[] = [/Bearer\s+[A-Za-z0-9._-]{16,}/gi, /SIGNOZ-API-KEY:\s*\S+/gi];

/**
 * Literal secret values registered at startup (e.g. the SigNoz API key). The
 * header patterns above only catch the header-prefixed forms; if a SigNoz
 * error body echoes back a bare key value with no header prefix, that would
 * slip through. Scrubbing the exact known value closes that gap regardless of
 * how it appears. Short values (< 8 chars) are ignored to avoid over-redacting
 * common substrings.
 */
const KNOWN_SECRETS = new Set<string>();

/** Escape a string for safe inclusion in a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Register a literal secret value that {@link redact} should always scrub.
 * Called once at startup with the configured API key, if any.
 */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) {
    KNOWN_SECRETS.add(value);
  }
}

export function redact(input: string): string {
  let out = input;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, "[REDACTED]");
  }
  for (const secret of KNOWN_SECRETS) {
    out = out.split(secret).join("[REDACTED]");
  }
  return out;
}

/** Truncate a string for safe logging. */
export function clip(input: string, max = 4000): string {
  const redacted = redact(input);
  return redacted.length > max ? `${redacted.slice(0, max)}…` : redacted;
}
