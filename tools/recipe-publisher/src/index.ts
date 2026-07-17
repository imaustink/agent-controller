import { config } from "./config.js";
import { createSink, JobEmitter } from "./messaging/index.js";
import { MealiePublishError, publishRecipe } from "./mealie/client.js";
import { extractMealieSlugMarker, parseRecipeMarkdown, renderMealieSlugMarker } from "./mealie/markdown-parser.js";
import { MarkdownInputSchema, type PublishErrorCode } from "./schema.js";
import { clip } from "./security/redact.js";

/** Process exit codes, so the parent agent can branch on failure class. */
const EXIT = {
  usage: 2,
  invalidRecipe: 3,
  mealieError: 4,
  general: 1,
} as const;

/**
 * A failure classified for both the process exit code and the structured
 * `failed` event — same pattern as tools/recipe-scraper/src/index.ts.
 */
class PipelineError extends Error {
  constructor(
    readonly code: PublishErrorCode,
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

function fail(code: PublishErrorCode, exitCode: number, message: string): never {
  throw new PipelineError(code, exitCode, clip(message, 2000));
}

async function run(emitter: JobEmitter, rawInput: string): Promise<void> {
  await emitter.progress("validate");

  const markdown = MarkdownInputSchema.safeParse(rawInput);
  if (!markdown.success) {
    fail("invalid_recipe", EXIT.invalidRecipe, `Input does not match the expected recipe markdown shape: ${markdown.error.message}`);
  }

  if (!config.mealieBaseUrl || !config.mealieApiToken) {
    fail("usage", EXIT.usage, "MEALIE_BASE_URL and MEALIE_API_TOKEN must be configured");
  }

  // A leading `<!-- mealie-slug: ... -->` marker (carried forward from a
  // previous publish's own response, see mealie/markdown-parser.ts) means
  // this call should UPDATE that recipe in place rather than create a new
  // one. Stripped before parsing so it never leaks into the recipe title.
  const { slug: existingSlug, markdown: recipeMarkdown } = extractMealieSlugMarker(markdown.data);

  // Guard against silently publishing an empty recipe: markdown-parser.ts
  // only recognizes numbered/bulleted list items, so input in an
  // unsupported shape (e.g. a plain paragraph, or a marker the parser
  // doesn't handle) parses to zero items -- previously this still reported
  // success with an empty recipe on Mealie's side.
  const parsedForValidation = parseRecipeMarkdown(recipeMarkdown);
  const hasIngredients = parsedForValidation.ingredientSections.some((s) => s.items.length > 0);
  const hasDirections = parsedForValidation.directionSections.some((s) => s.items.length > 0);
  if (!hasIngredients || !hasDirections) {
    const missing = [!hasIngredients && "ingredients", !hasDirections && "directions"].filter(Boolean).join(" and ");
    fail(
      "invalid_recipe",
      EXIT.invalidRecipe,
      `Parsed recipe markdown has no ${missing} -- expected numbered (1. item) or bulleted (-/*/• item) ` +
        `lists under "## Ingredients"/"## Directions" headings`,
    );
  }

  await emitter.progress("publish");
  let result;
  try {
    result = await publishRecipe(
      {
        baseUrl: config.mealieBaseUrl,
        token: config.mealieApiToken,
        fetchTimeoutMs: config.fetchTimeoutMs,
        ingredientParser: config.mealieIngredientParser,
      },
      recipeMarkdown,
      fetch,
      existingSlug ?? undefined,
    );
  } catch (err) {
    if (err instanceof MealiePublishError) {
      fail("mealie_error", EXIT.mealieError, `Publishing to Mealie failed: ${err.message}`);
    }
    fail("mealie_error", EXIT.mealieError, `Publishing to Mealie failed: ${(err as Error).message}`);
  }

  // The marker is prepended (invisible in a rendered chat message, but
  // present in the raw text) so the *next* turn can read it back and keep
  // editing the same Mealie recipe -- see mealie/markdown-parser.ts.
  const confirmation = `${renderMealieSlugMarker(result.slug)}${recipeMarkdown}\n\n---\n✅ ${
    result.created ? "Published" : "Updated"
  } on Mealie: [${result.name}](${result.url})`;
  await emitter.succeeded(confirmation);
}

async function main(): Promise<void> {
  const sink = createSink(config);
  const emitter = new JobEmitter(config.jobId, sink);
  const rawInput = process.argv[2];

  try {
    if (!rawInput) {
      fail("usage", EXIT.usage, "Usage: recipe-publisher <recipe-markdown>");
    }
    await emitter.accepted(clip(rawInput, 200));
    await run(emitter, rawInput);
    await emitter.close();
  } catch (err) {
    const { code, exitCode, message } = toPipelineError(err);
    process.stderr.write(`${message}\n`);
    try {
      await emitter.failed(code, message);
      await emitter.close();
    } catch {
      // The event stream is best-effort on the failure path; the exit code
      // remains the authoritative backstop.
    }
    process.exit(exitCode);
  }
}

function toPipelineError(err: unknown): { code: PublishErrorCode; exitCode: number; message: string } {
  if (err instanceof PipelineError) {
    return { code: err.code, exitCode: err.exitCode, message: err.message };
  }
  return {
    code: "general",
    exitCode: EXIT.general,
    message: clip(`Unexpected error: ${(err as Error).message}`, 2000),
  };
}

void main();
