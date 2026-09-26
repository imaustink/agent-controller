/**
 * Matches a caller-supplied path against a driver's allowlist.
 *
 * The GET face takes a path from a model, and a provider API is far larger
 * than the part a knowledge base needs. Without an allowlist this would be a
 * general proxy onto a client's credential, which is a different and much worse
 * thing than a live view of indexed material.
 *
 * Anchored patterns only, and the caller gets back the captured id rather than
 * the path — so nothing downstream can be fed a string the allowlist did not
 * actually vouch for.
 */
export function matchPath(path: string, patterns: RegExp[]): string | undefined {
  // Normalised first: a leading slash, a trailing one, or any traversal segment
  // would otherwise have to be handled identically by every pattern.
  const normalised = path.replace(/^\/+/, "").replace(/\/+$/, "");
  if (normalised.includes("..") || normalised.includes("//")) return undefined;

  for (const pattern of patterns) {
    const match = pattern.exec(normalised);
    if (match) return match[1];
  }
  return undefined;
}
