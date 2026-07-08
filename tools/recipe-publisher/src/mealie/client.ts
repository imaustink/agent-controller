import { randomUUID } from "node:crypto";
import type { PublishResult } from "../schema.js";
import { parseRecipeMarkdown, type ParsedSection } from "./markdown-parser.js";

export interface MealieConfig {
  /** Fixed, trusted server-side configuration -- never derived from tool input. */
  baseUrl: string;
  token: string;
  fetchTimeoutMs: number;
  /** Which of Mealie's registered ingredient parsers to use -- see toMealieIngredients. */
  ingredientParser: "nlp" | "brute" | "openai";
}

export class MealiePublishError extends Error {}

type FetchLike = typeof fetch;

function mealieHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/json",
    "content-type": "application/json",
  };
}

async function fetchWithTimeout(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Never follow redirects: the target host is fixed configuration, not
    // something we want silently re-pointed by a 3xx response.
    return await fetchImpl(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "<no body>";
  }
}

/**
 * Sends the flat ingredient text lines to Mealie's own ingredient parser
 * (`POST /api/parser/ingredients`) so quantity/unit/food come out as real
 * structured fields instead of one opaque `note` string -- this is what lets
 * Mealie's unit conversion, recipe scaling, and shopping-list quantities work
 * for these ingredients. Best-effort: recipe-scraper's plain text isn't
 * always parseable, and the parser call itself can fail (auth, network,
 * Mealie version without the parser configured) -- on any failure this
 * returns `undefined` and the caller falls back to unparsed `note`-only
 * entries, so a parser problem never blocks the publish itself.
 */
async function parseIngredientTexts(
  cfg: MealieConfig,
  fetchImpl: FetchLike,
  texts: string[],
): Promise<Record<string, unknown>[] | undefined> {
  if (texts.length === 0) return [];
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${cfg.baseUrl}/api/parser/ingredients`,
      {
        method: "POST",
        headers: mealieHeaders(cfg.token),
        body: JSON.stringify({ parser: cfg.ingredientParser, ingredients: texts }),
      },
      cfg.fetchTimeoutMs,
    );
    if (!res.ok) {
      console.error(`Mealie ingredient parser failed (${res.status}); falling back to unparsed notes`);
      return undefined;
    }
    const parsed = (await res.json()) as { ingredient: Record<string, unknown> }[];
    return parsed.map((p) => p.ingredient);
  } catch (err) {
    console.error(`Mealie ingredient parser request failed; falling back to unparsed notes: ${(err as Error).message}`);
    return undefined;
  }
}

/**
 * Maps parsed ingredient sections onto Mealie's flat `recipeIngredient`
 * array. A named section becomes a header-only entry (`title` set, nothing
 * else) followed by its items -- Mealie's own ingredient editor uses this
 * same convention to render group headers within one ingredient list. Each
 * item is run through Mealie's own ingredient parser first (see
 * {@link parseIngredientTexts}); only items it couldn't parse (or if the
 * parser call itself failed) fall back to a plain `note`/`disableAmount`
 * entry with no structured quantity/unit/food.
 */
async function toMealieIngredients(
  cfg: MealieConfig,
  fetchImpl: FetchLike,
  sections: ParsedSection[],
): Promise<Record<string, unknown>[]> {
  const allItems = sections.flatMap((section) => section.items);
  const parsedIngredients = await parseIngredientTexts(cfg, fetchImpl, allItems);

  const result: Record<string, unknown>[] = [];
  let cursor = 0;
  for (const section of sections) {
    if (section.name) {
      result.push({ title: section.name, note: "", originalText: "", display: "", disableAmount: true });
    }
    for (const item of section.items) {
      const parsed = parsedIngredients?.[cursor];
      cursor++;
      result.push(parsed ? { ...parsed, title: null } : { title: null, note: item, originalText: item, display: item, disableAmount: true });
    }
  }
  return result;
}

/**
 * Maps parsed direction sections onto Mealie's `recipeInstructions` array.
 * Each step carries the section name (if any) as its own `title` -- Mealie's
 * step editor groups consecutive steps sharing a `title` into a section.
 */
function toMealieInstructions(sections: ParsedSection[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const section of sections) {
    for (const item of section.items) {
      result.push({ title: section.name, text: item });
    }
  }
  return result;
}

/**
 * Resolves each equipment name to a Mealie `RecipeTool` (Mealie's first-class
 * equipment entity, referenced by recipes and searchable/filterable on their
 * own): looks up an existing tool by name first, creating one if none
 * matches. Best-effort per item -- an item that can't be resolved (search or
 * create call failed) is simply left out of the returned list, and the
 * caller falls back to a plain "Equipment" note for anything unresolved so
 * nothing is silently dropped from the published recipe.
 */
async function resolveToolRefs(
  cfg: MealieConfig,
  fetchImpl: FetchLike,
  equipment: string[],
): Promise<{ resolved: Record<string, unknown>[]; unresolved: string[] }> {
  const resolved: Record<string, unknown>[] = [];
  const unresolved: string[] = [];

  for (const name of equipment) {
    try {
      const searchRes = await fetchWithTimeout(
        fetchImpl,
        `${cfg.baseUrl}/api/organizers/tools?search=${encodeURIComponent(name)}&perPage=10`,
        { method: "GET", headers: mealieHeaders(cfg.token) },
        cfg.fetchTimeoutMs,
      );
      if (searchRes.ok) {
        const page = (await searchRes.json()) as { items?: Record<string, unknown>[] };
        const match = page.items?.find((tool) => typeof tool.name === "string" && tool.name.toLowerCase() === name.toLowerCase());
        if (match) {
          resolved.push(match);
          continue;
        }
      }

      const createRes = await fetchWithTimeout(
        fetchImpl,
        `${cfg.baseUrl}/api/organizers/tools`,
        { method: "POST", headers: mealieHeaders(cfg.token), body: JSON.stringify({ name }) },
        cfg.fetchTimeoutMs,
      );
      if (createRes.ok) {
        resolved.push((await createRes.json()) as Record<string, unknown>);
      } else {
        unresolved.push(name);
      }
    } catch (err) {
      console.error(`Failed to resolve Mealie tool "${name}"; falling back to an Equipment note: ${(err as Error).message}`);
      unresolved.push(name);
    }
  }

  return { resolved, unresolved };
}

/** Folds tips (and any equipment that couldn't be resolved as a Mealie Tool) into recipe notes. */
function toMealieNotes(unresolvedEquipment: string[], tips: string[]): { title: string; text: string }[] {
  const notes: { title: string; text: string }[] = [];
  if (unresolvedEquipment.length > 0) {
    notes.push({ title: "Equipment", text: unresolvedEquipment.map((item) => `- ${item}`).join("\n") });
  }
  if (tips.length > 0) {
    notes.push({ title: "Tips", text: tips.map((item, i) => `${i + 1}. ${item}`).join("\n") });
  }
  return notes;
}

/** Looks up the current household's group slug, used only to build a human-clickable recipe URL in the result. */
async function fetchGroupSlug(cfg: MealieConfig, fetchImpl: FetchLike): Promise<string | undefined> {
  const res = await fetchWithTimeout(
    fetchImpl,
    `${cfg.baseUrl}/api/groups/self`,
    { method: "GET", headers: mealieHeaders(cfg.token) },
    cfg.fetchTimeoutMs,
  );
  if (!res.ok) return undefined;
  const body = (await res.json()) as { slug?: string };
  return body.slug;
}

/**
 * Publishes the recipe Markdown to Mealie. When `existingSlug` is given
 * (extracted from a `<!-- mealie-slug: ... -->` marker carried forward from
 * a previous turn — see mealie/markdown-parser.ts), this UPDATES that
 * recipe in place via `PATCH` instead of creating a new one, so iterative
 * refinement after the first publish edits the same Mealie recipe rather
 * than accumulating duplicates. Otherwise it creates a new recipe by name
 * (Mealie assigns the slug) before patching in the parsed data. `cfg.baseUrl`
 * is always fixed server-side configuration, never taken from `markdown` or
 * caller input.
 */
export async function publishRecipe(
  cfg: MealieConfig,
  markdown: string,
  fetchImpl: FetchLike = fetch,
  existingSlug?: string,
): Promise<PublishResult> {
  const parsed = parseRecipeMarkdown(markdown);
  const name = parsed.title ?? `Recipe ${randomUUID()}`;

  let slug: string;
  let created: boolean;
  if (existingSlug) {
    slug = existingSlug;
    created = false;
  } else {
    const createRes = await fetchWithTimeout(
      fetchImpl,
      `${cfg.baseUrl}/api/recipes`,
      { method: "POST", headers: mealieHeaders(cfg.token), body: JSON.stringify({ name }) },
      cfg.fetchTimeoutMs,
    );
    if (!createRes.ok) {
      throw new MealiePublishError(`Mealie POST /api/recipes failed: ${createRes.status} ${await safeText(createRes)}`);
    }
    const newSlug = (await createRes.json()) as string;
    if (!newSlug || typeof newSlug !== "string") {
      throw new MealiePublishError("Mealie POST /api/recipes succeeded but returned an unexpected response shape");
    }
    slug = newSlug;
    created = true;
  }

  const [recipeIngredient, { resolved: tools, unresolved: unresolvedEquipment }] = await Promise.all([
    toMealieIngredients(cfg, fetchImpl, parsed.ingredientSections),
    resolveToolRefs(cfg, fetchImpl, parsed.equipment),
  ]);

  const patchBody: Record<string, unknown> = {
    name,
    recipeIngredient,
    recipeInstructions: toMealieInstructions(parsed.directionSections),
    notes: toMealieNotes(unresolvedEquipment, parsed.tips),
    tools,
  };
  if (parsed.sourceUrl) patchBody.orgURL = parsed.sourceUrl;

  const patchRes = await fetchWithTimeout(
    fetchImpl,
    `${cfg.baseUrl}/api/recipes/${encodeURIComponent(slug)}`,
    { method: "PATCH", headers: mealieHeaders(cfg.token), body: JSON.stringify(patchBody) },
    cfg.fetchTimeoutMs,
  );
  if (!patchRes.ok) {
    throw new MealiePublishError(`Mealie PATCH /api/recipes/${slug} failed: ${patchRes.status} ${await safeText(patchRes)}`);
  }

  const groupSlug = await fetchGroupSlug(cfg, fetchImpl);
  const url = groupSlug ? `${cfg.baseUrl}/g/${groupSlug}/r/${slug}` : `${cfg.baseUrl}/recipe/${slug}`;

  return { slug, name, url, created };
}
