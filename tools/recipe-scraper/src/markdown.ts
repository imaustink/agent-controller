import type { Envelope, RecipeSection } from "./schema.js";

/**
 * Renders the validated {@link Envelope} as human-readable Markdown instead
 * of raw JSON -- easier for a user to read in a chat UI, and easier for an
 * LLM to make targeted in-place edits to during the skill's "adjust" step
 * (see apps/agent-orchestrator/src/skills/catalog.ts). This is a pure,
 * deterministic renderer over already-validated structured data (produced by
 * Structured Outputs in llm/format.ts) -- it does NOT ask an LLM to produce
 * prose, so the prompt-injection containment documented there is unaffected.
 */

function renderNumberedList(items: string[]): string {
  return items
    .filter((item) => item.trim().length > 0)
    .map((item, i) => `${i + 1}. ${item}`)
    .join("\n");
}

/**
 * Renders a group of sections. A single unnamed section (the common case --
 * no natural subdivision) renders as a flat numbered list; multiple (or
 * named) sections each get their own `###` subheading.
 */
function renderSectionGroup(sections: RecipeSection[]): string {
  if (sections.length === 0) return "";
  const [only] = sections;
  if (sections.length === 1 && only && only.name == null) {
    return renderNumberedList(only.items);
  }
  return sections.map((section) => `### ${section.name ?? "Additional"}\n${renderNumberedList(section.items)}`).join("\n\n");
}

export function renderMarkdown(envelope: Envelope): string {
  const { recipe } = envelope;
  const blocks: string[] = [`# ${envelope.title ?? "Untitled Recipe"}`];

  blocks.push(`## Ingredients\n\n${renderSectionGroup(recipe.ingredientSections)}`);
  blocks.push(`## Directions\n\n${renderSectionGroup(recipe.directionSections)}`);

  if (recipe.equipment.length > 0) {
    blocks.push(`## Equipment\n\n${renderNumberedList(recipe.equipment)}`);
  }
  if (recipe.tips.length > 0) {
    blocks.push(`## Tips\n\n${renderNumberedList(recipe.tips)}`);
  }

  blocks.push(`[Source](${envelope.url})`);

  return blocks.join("\n\n");
}
