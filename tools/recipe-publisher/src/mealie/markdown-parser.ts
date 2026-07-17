/**
 * Parses the recipe Markdown produced by tools/recipe-scraper's renderer
 * (see ../../../recipe-scraper/src/markdown.ts) back into structured data so
 * it can be mapped onto Mealie's recipe fields (recipeIngredient/
 * recipeInstructions/notes) -- the inverse of that tool's `renderMarkdown`.
 * This is a pure, deterministic parser over already-rendered Markdown, not
 * an LLM call -- same "structured data in, structured data out" discipline
 * used throughout this repo to avoid prompt-injection surfaces.
 *
 * Expected shape (see recipe-scraper's renderer for the authoritative format):
 *   # Title
 *
 *   ## Ingredients
 *   1. item
 *   (or, for multi-component recipes:)
 *   ### Section Name
 *   1. item
 *
 *   ## Directions
 *   (same numbered-list / ### subsection structure)
 *
 *   ## Equipment
 *   1. item
 *
 *   ## Tips
 *   1. item
 *
 *   [Source](<url>)
 */

/** A named (or unnamed) group of items -- mirrors recipe-scraper's `RecipeSection`. */
export interface ParsedSection {
  name: string | null;
  items: string[];
}

export interface ParsedRecipeMarkdown {
  title: string | null;
  ingredientSections: ParsedSection[];
  directionSections: ParsedSection[];
  equipment: string[];
  tips: string[];
  sourceUrl: string | null;
}

/**
 * Parses a rendered list back into a plain string array. Primarily targets
 * recipe-scraper's numbered-list output (`1. foo\n2. bar`), but also accepts
 * `-`/`*`/`•` bullet markers -- recipes composed or edited directly by the
 * orchestrator LLM (rather than scraped from a URL) commonly use bullets, and
 * silently parsing zero items from those was publishing empty recipes to
 * Mealie with no error (see run() in ../index.ts for the empty-section guard).
 */
function parseNumberedList(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.match(/^(?:\d+\.|[-*•])\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => match[1]!.trim())
    .filter((item) => item.length > 0);
}

/** Parses a `## Ingredients`/`## Directions` block body, splitting on `### ` subsections if present. */
function parseSectionGroup(body: string): ParsedSection[] {
  if (!/^###\s+.+$/m.test(body)) {
    return [{ name: null, items: parseNumberedList(body) }];
  }
  const sections: ParsedSection[] = [];
  const parts = body.split(/^###\s+(.+)$/m);
  // parts alternates [preamble, name, content, name, content, ...]
  // Include any numbered items that appear before the first ### header (e.g. when
  // the orchestrator LLM edits a recipe and mixes flat items with subsections)
  // rather than silently discarding them.
  const preambleItems = parseNumberedList(parts[0] ?? "");
  if (preambleItems.length > 0) {
    sections.push({ name: null, items: preambleItems });
  }
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i]!.trim();
    sections.push({ name, items: parseNumberedList(parts[i + 1] ?? "") });
  }
  return sections;
}

export function parseRecipeMarkdown(markdown: string): ParsedRecipeMarkdown {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : null;

  const sourceMatch = markdown.match(/\[Source\]\((.+?)\)/);
  const sourceUrl = sourceMatch ? sourceMatch[1]!.trim() : null;

  const blocks = new Map<string, string>();
  const headingMatches = [...markdown.matchAll(/^##\s+(.+)$/gm)];
  for (let i = 0; i < headingMatches.length; i++) {
    const match = headingMatches[i]!;
    const heading = match[1]!.trim().toLowerCase();
    const start = match.index! + match[0].length;
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1]!.index! : markdown.length;
    blocks.set(heading, markdown.slice(start, end).trim());
  }

  return {
    title,
    ingredientSections: blocks.has("ingredients") ? parseSectionGroup(blocks.get("ingredients")!) : [],
    directionSections: blocks.has("directions") ? parseSectionGroup(blocks.get("directions")!) : [],
    equipment: blocks.has("equipment") ? parseNumberedList(blocks.get("equipment")!) : [],
    tips: blocks.has("tips") ? parseNumberedList(blocks.get("tips")!) : [],
    sourceUrl,
  };
}

/**
 * Round-trips the identity of an already-published Mealie recipe through the
 * session store (docs/adr/0016). The orchestrator strips the
 * `<!-- continuation: <slug> -->` marker from the tool's success output,
 * stores the slug server-side keyed by tool id, and re-injects it at the
 * front of tool_args on the next turn. The token never appears in the chat
 * transcript the LLM planner sees, removing the prior prompt-injection risk
 * (docs/security.md).
 */
const CONTINUATION_MARKER = /^<!--\s*continuation:\s*([a-z0-9-]+)\s*-->\r?\n*/i;

/** Strips a leading `<!-- continuation: <slug> -->` marker if present, returning it separately from the rest of the markdown. */
export function extractMealieSlugMarker(markdown: string): { slug: string | null; markdown: string } {
  const match = markdown.match(CONTINUATION_MARKER);
  if (!match) return { slug: null, markdown };
  return { slug: match[1]!.toLowerCase(), markdown: markdown.slice(match[0].length) };
}

/** Renders the generic continuation marker to prepend to a published/updated recipe's output, so the orchestrator can extract and store the slug. */
export function renderMealieSlugMarker(slug: string): string {
  return `<!-- continuation: ${slug} -->\n\n`;
}
