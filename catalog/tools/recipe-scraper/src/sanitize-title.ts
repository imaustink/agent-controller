/**
 * Cleans up a raw page/video title for display:
 * 1. Strips emoji (Emoji_Presentation characters — always rendered as pictures, never plain text).
 * 2. Drops pipe-separated subtitles (`Title | Site name` or `Title | Tagline`) that web
 *    pages and video platforms routinely append to their <title> tags.
 * 3. Collapses excess whitespace.
 * Returns null when the raw title is null or becomes empty after cleaning.
 */
export function sanitizeTitle(raw: string | null): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/\p{Emoji_Presentation}/gu, "") // strip pictographic emoji
    .replace(/\s*\|.*$/s, "")               // drop pipe-separated subtitle/site-name suffix
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}
