import { z } from "zod";

/**
 * This tool's input is a plain search query string -- no structure to
 * validate beyond "non-empty" and a sane upper bound (SearXNG's own `q`
 * param has no hard limit, but an unbounded query is never a legitimate
 * search and only helps pad a request).
 */
export const QueryInputSchema = z.string().trim().min(1, "Search query must not be empty").max(2000, "Search query is too long");

/** A single SearXNG result, trimmed to what's rendered in the tool's Markdown output. */
export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  content: z.string().optional().default(""),
});

/** SearXNG's `?format=json` response shape, narrowed to the fields this tool uses. */
export const SearxngResponseSchema = z.object({
  results: z.array(SearchResultSchema),
});

export type SearchResult = z.infer<typeof SearchResultSchema>;

/** Pipeline stages emitted via the messaging protocol (docs/messaging.md). */
export type SearchStage = "search";

/** Error taxonomy (plain TS union, not runtime-validated -- same convention as recipe-publisher). */
export type SearchErrorCode = "usage" | "search_error" | "general";
