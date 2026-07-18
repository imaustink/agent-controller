/**
 * Parses recipe Markdown back into structured data so it can be mapped onto
 * Mealie's recipe fields (recipeIngredient/recipeInstructions/notes). This is
 * the inverse of tools/recipe-scraper's `renderMarkdown` (../../../recipe-scraper/src/markdown.ts),
 * but the recipe-refining skill also allows a recipe pasted or composed
 * directly by the user or the orchestrator LLM instead of one scraped from a
 * URL (see charts/community-components/templates/skill-recipe-refining.yaml),
 * so this parser tolerates reasonable formatting variance from that
 * canonical shape rather than requiring an exact match (see
 * `canonicalHeadingKey` and `headingBody` below). This is still a pure,
 * deterministic parser over already-rendered Markdown, not an LLM call --
 * same "structured data in, structured data out" discipline used throughout
 * this repo to avoid prompt-injection surfaces.
 *
 * Canonical shape (see recipe-scraper's renderer for the authoritative format):
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
 *
 * Tolerated variance: any heading level (not just `##`/`###`) as long as
 * subsections are nested one level deeper than their parent section, plus
 * "Instructions"/"Steps"/"Method"/"Preparation" as synonyms for "Directions".
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
 *
 * A line that's INDENTED (rather than a new marker at column 0) is treated as
 * a continuation of the item above it -- e.g. a bold lead-in step followed by
 * the actual detail as a nested sub-bullet:
 *   1. **Prepare the peaches:**
 *      - Peel, pit, and slice.
 * Without this, that detail line is silently dropped (it doesn't match the
 * marker regex at column 0), leaving a step that's just a colon with nothing
 * after it. Only indentation triggers a merge -- an unindented trailing line
 * (e.g. the `[Source](<url>)` line after the last section) is never folded
 * into the previous item.
 */
function parseNumberedList(text: string): string[] {
  const items: string[] = [];
  for (const rawLine of text.split("\n")) {
    const marker = rawLine.match(/^(?:\d+\.|[-*•])\s+(.+)$/);
    if (marker) {
      items.push(marker[1]!.trim());
      continue;
    }
    const indented = rawLine.match(/^[ \t]+(?:[-*•]\s+)?(.+)$/);
    if (indented && items.length > 0) {
      const continuation = indented[1]!.trim();
      if (continuation.length > 0) {
        items[items.length - 1] = `${items[items.length - 1]} ${continuation}`;
      }
    }
  }
  return items.filter((item) => item.length > 0);
}

/**
 * Recipes handed to this tool don't always come from recipe-scraper's own
 * renderer -- the recipe-refining skill also accepts a recipe pasted or
 * composed directly by the user or the orchestrator LLM (see
 * charts/community-components/templates/skill-recipe-refining.yaml), which
 * commonly uses a shallower/deeper heading level (`### Ingredients` instead
 * of `## Ingredients`) or a different label for the same section
 * ("Instructions"/"Steps"/"Method" instead of "Directions"). Both are
 * normalized here so those recipes don't get rejected as "no ingredients/
 * directions found" just because of a harmless formatting choice.
 */
const DIRECTIONS_HEADING_ALIASES = new Set(["directions", "instructions", "steps", "method", "preparation"]);

const KNOWN_SECTION_KEYS = new Set(["ingredients", "directions", "equipment", "tips"]);

/** Trims a heading's own trailing punctuation (`## Ingredients:`) -- common in casually-authored Markdown, harmless to the heading's meaning. */
function normalizeHeadingText(heading: string): string {
  return heading.trim().replace(/[:.]+\s*$/, "").trim();
}

function canonicalHeadingKey(heading: string): string {
  const key = normalizeHeadingText(heading).toLowerCase();
  return DIRECTIONS_HEADING_ALIASES.has(key) ? "directions" : key;
}

/** Parses a section block body, splitting on any nested heading (a subsection is always a deeper level than its parent -- see {@link findHeadingMatches}). */
function parseSectionGroup(body: string): ParsedSection[] {
  if (!/^#{1,6}\s+.+$/m.test(body)) {
    return [{ name: null, items: parseNumberedList(body) }];
  }
  const sections: ParsedSection[] = [];
  const parts = body.split(/^#{1,6}\s+(.+)$/m);
  // parts alternates [preamble, name, content, name, content, ...]
  // Include any numbered items that appear before the first subheading (e.g. when
  // the orchestrator LLM edits a recipe and mixes flat items with subsections)
  // rather than silently discarding them.
  const preambleItems = parseNumberedList(parts[0] ?? "");
  if (preambleItems.length > 0) {
    sections.push({ name: null, items: preambleItems });
  }
  for (let i = 1; i < parts.length; i += 2) {
    const name = normalizeHeadingText(parts[i] ?? "");
    sections.push({ name, items: parseNumberedList(parts[i + 1] ?? "") });
  }
  return sections;
}

interface HeadingMatch {
  level: number;
  heading: string;
  index: number;
  bodyStart: number;
}

/** Every ATX heading (`#` through `######`) in document order, regardless of level. */
function findHeadingMatches(markdown: string): HeadingMatch[] {
  return [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)].map((match) => ({
    level: match[1]!.length,
    heading: match[2]!.trim(),
    index: match.index!,
    bodyStart: match.index! + match[0].length,
  }));
}

/**
 * A heading's body runs until the next heading at the SAME OR SHALLOWER
 * level (a deeper heading, e.g. `###` nested under a `##` section, is a
 * subsection and stays part of the body for {@link parseSectionGroup} to
 * split out). This is level-relative rather than hardcoded to `##`/`###` so
 * a recipe using `###` (or any other level) consistently for its main
 * sections still parses correctly.
 */
function headingBody(matches: HeadingMatch[], i: number, markdown: string): string {
  const { level, bodyStart } = matches[i]!;
  const next = matches.slice(i + 1).find((m) => m.level <= level);
  return markdown.slice(bodyStart, next?.index ?? markdown.length).trim();
}

export function parseRecipeMarkdown(markdown: string): ParsedRecipeMarkdown {
  const sourceMatch = markdown.match(/\[Source\]\((.+?)\)/);
  const sourceUrl = sourceMatch ? sourceMatch[1]!.trim() : null;

  const headingMatches = findHeadingMatches(markdown);
  // The title is the first heading that ISN'T one of the known section
  // labels, at whatever level it happens to use -- not hardcoded to a single
  // `#` -- since a recipe pasted or composed directly (rather than rendered
  // by recipe-scraper's own `# Title` convention) may title itself with any
  // heading depth (e.g. `### Peach Cocktail Syrup`).
  const titleMatch = headingMatches.find((m) => !KNOWN_SECTION_KEYS.has(canonicalHeadingKey(m.heading)));
  const title = titleMatch ? normalizeHeadingText(titleMatch.heading) : null;

  const blocks = new Map<string, string>();
  for (let i = 0; i < headingMatches.length; i++) {
    const key = canonicalHeadingKey(headingMatches[i]!.heading);
    if (!blocks.has(key)) {
      blocks.set(key, headingBody(headingMatches, i, markdown));
    }
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
