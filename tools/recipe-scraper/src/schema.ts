import { z } from "zod";

/**
 * A named (or unnamed) group of numbered items — used for both ingredients
 * and directions so multi-component recipes (e.g. "Crumble Topping" +
 * "Muffins") can be rendered as separate subsections. `name: null` means "no
 * subsection heading" (the common case: a single flat numbered list).
 */
export const RecipeSectionSchema = z.object({
  name: z.string().nullable(),
  items: z.array(z.string().min(1)),
});

export type RecipeSection = z.infer<typeof RecipeSectionSchema>;

/** The normalized recipe artifact this subagent produces. */
export const RecipeSchema = z.object({
  name: z.string().nullable(),
  ingredientSections: z.array(RecipeSectionSchema),
  directionSections: z.array(RecipeSectionSchema),
  equipment: z.array(z.string()),
  tips: z.array(z.string()),
});

export type Recipe = z.infer<typeof RecipeSchema>;

/**
 * JSON Schema mirror of {@link RecipeSchema}, used with OpenAI Structured
 * Outputs. `strict` mode requires every property to be listed in `required`
 * and `additionalProperties: false`. Constraining the model to this schema is
 * a primary prompt-injection mitigation: no matter what the scraped content
 * says, the only thing the model can emit is a recipe object.
 */
const RECIPE_SECTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "items"],
  properties: {
    name: { type: ["string", "null"] },
    items: { type: "array", items: { type: "string", minLength: 1 } },
  },
} as const;

export const RECIPE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ingredientSections", "directionSections", "equipment", "tips"],
  properties: {
    name: { type: ["string", "null"] },
    ingredientSections: { type: "array", items: RECIPE_SECTION_JSON_SCHEMA },
    directionSections: { type: "array", items: RECIPE_SECTION_JSON_SCHEMA },
    equipment: { type: "array", items: { type: "string" } },
    tips: { type: "array", items: { type: "string" } },
  },
} as const;

export const SourceTypeSchema = z.enum(["video", "image", "web", "tiktok_photo"]);
export type SourceType = z.infer<typeof SourceTypeSchema>;

/** The recipe artifact + provenance — the payload of a successful tool call. */
export const EnvelopeSchema = z.object({
  source_type: SourceTypeSchema,
  url: z.string(),
  title: z.string().nullable(),
  recipe: RecipeSchema,
  provenance: z.record(z.unknown()),
  warnings: z.array(z.string()),
});

export type Envelope = z.infer<typeof EnvelopeSchema>;

/**
 * Failure taxonomy for `failed` events. Mirrors the process exit codes in
 * index.ts so the parent orchestrator can branch on failure class regardless
 * of which transport delivered the event. Plain TS union (not zod): these
 * values are only ever constructed by this tool's own code, never parsed from
 * untrusted input, so runtime validation belongs to the shared
 * `@controller-agent/messaging` package's generic `EventSchema` instead.
 */
export type ErrorCode = "usage" | "blocked_url" | "extraction" | "formatting" | "general";

/** Pipeline stages surfaced in `progress` events. */
export type Stage = "classify" | "extract" | "transcribe" | "format";

