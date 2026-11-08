import type { ToolInput } from "./schema.js";

/**
 * Renders the succeeded result as Markdown. Keeping the presigned URL on its
 * own `![...](url)` line (a) lets a chat client render the image inline and
 * (b) lets this skill find the URL again next turn to feed back as the edit
 * source -- so the result is both human- and machine-readable, the same way
 * recipe-scraper's Markdown carries a `[Source](url)` line forward.
 */
export function renderResult(input: ToolInput, url: string): string {
  const action = input.image_url ? "Edited image" : "Generated image";
  const alt = input.prompt.length > 120 ? `${input.prompt.slice(0, 120)}…` : input.prompt;
  return [`**${action}**`, "", `![${alt}](${url})`, "", `Prompt: ${input.prompt}`].join("\n");
}
