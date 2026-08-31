import { z } from "zod";

/**
 * The tool's input is a single argv string. It is EITHER a JSON object with the
 * fields below, OR a bare prompt string (shorthand for `{ "prompt": "<text>" }`).
 *
 * `image_url` present => edit an existing image; absent => generate from scratch.
 * That single branch is how one tool covers both generation and iterative
 * refinement: the skill feeds the previous result's URL back in as `image_url`.
 */
export const InputSchema = z.object({
  prompt: z.string().trim().min(1, "prompt must not be empty").max(4000, "prompt is too long"),
  /** URL of a prior image to edit. When set, the tool runs the edit branch. */
  image_url: z.string().trim().url().max(4000).optional(),
  /** e.g. "1024x1024", "1024x1536", "1536x1024", "auto". Defaults from config. */
  size: z.string().trim().max(32).optional(),
  /** "low" | "medium" | "high" | "auto". Defaults from config. */
  quality: z.string().trim().max(16).optional(),
  /** "transparent" | "opaque" | "auto" (generation only). */
  background: z.string().trim().max(16).optional(),
});

export type ToolInput = z.infer<typeof InputSchema>;

/**
 * Parses the raw argv string. Tries JSON first; a non-JSON string is treated as
 * a bare prompt. Throws a plain Error with a readable message on invalid input;
 * the caller maps that to the `usage` error class.
 */
export function parseInput(raw: string): ToolInput {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("input must not be empty");

  let candidate: unknown;
  if (trimmed.startsWith("{")) {
    try {
      candidate = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(`input looked like JSON but failed to parse: ${(err as Error).message}`);
    }
  } else {
    candidate = { prompt: trimmed };
  }

  const result = InputSchema.safeParse(candidate);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  }
  return result.data;
}

/** Pipeline stages emitted via the messaging protocol (docs/messaging.md). */
export type Stage = "download" | "generate" | "edit" | "upload";

/** Error taxonomy (plain TS union, same convention as recipe-scraper/web-fetch). */
export type ErrorCode = "usage" | "blocked_url" | "provider_error" | "storage_error" | "general";
