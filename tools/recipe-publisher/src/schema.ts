import { z } from "zod";

/**
 * This tool's input is now the rendered recipe Markdown produced by
 * tools/recipe-scraper (see its src/markdown.ts) -- not the old structured
 * Envelope/Recipe JSON. Markdown is easier for a user to read and for the
 * orchestrator's skill to make targeted edits to; there's nothing left to
 * structurally validate beyond "non-empty text", so this is a thin schema
 * rather than a full domain model.
 */
export const MarkdownInputSchema = z.string().min(1, "Recipe markdown must not be empty");

/**
 * Extracts the recipe title from a leading `# Title` heading (as produced by
 * tools/recipe-scraper's markdown renderer). Returns `null` if no such
 * heading is found -- Mealie assigns a slug/title on its own in that case,
 * this is purely for a nicer default, never required for the publish to
 * succeed.
 */
export function parseTitle(markdown: string): string | null {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1]!.trim() : null;
}

/** Result of a successful publish, used internally to build the tool's `succeeded` message text (see index.ts). */
export const PublishResultSchema = z.object({
  slug: z.string(),
  name: z.string(),
  url: z.string(),
  /** Whether this call created a new Mealie recipe (`true`) or updated an existing one via a carried-forward slug marker (`false`). */
  created: z.boolean(),
});

export type PublishResult = z.infer<typeof PublishResultSchema>;

/** Pipeline stages emitted via the messaging protocol (docs/messaging.md). */
export type PublishStage = "validate" | "publish";

/** Error taxonomy (plain TS union, not runtime-validated — same convention as recipe-scraper). */
export type PublishErrorCode = "usage" | "invalid_recipe" | "mealie_error" | "general";
