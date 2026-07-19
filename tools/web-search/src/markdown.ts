import type { SearchResult } from "./schema.js";

/** Renders SearXNG results as a flat Markdown list, capped to `maxResults`. */
export function renderResults(query: string, results: SearchResult[], maxResults: number): string {
  const shown = results.slice(0, maxResults);
  if (shown.length === 0) {
    return `No results found for "${query}".`;
  }
  const lines = shown.map((r) => {
    const snippet = r.content.trim();
    return snippet ? `- [${r.title}](${r.url}): ${snippet}` : `- [${r.title}](${r.url})`;
  });
  return [`Search results for "${query}":`, "", ...lines].join("\n");
}
