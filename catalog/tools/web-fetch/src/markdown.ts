import type { Extraction } from "./extract.js";

/** Collapses runs of blank lines Readability's textContent tends to leave behind. */
function normalizeWhitespace(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Renders an extracted page as Markdown, truncated to `maxChars`. */
export function renderPage(url: string, extraction: Extraction, maxChars: number): string {
  const heading = extraction.title ? `# ${extraction.title}` : `# ${url}`;
  const body = normalizeWhitespace(extraction.text);

  if (!body) {
    return [heading, "", `Source: ${url}`, "", "No readable text content was found on this page."].join("\n");
  }

  const truncated = body.length > maxChars;
  const shown = truncated ? body.slice(0, maxChars).trimEnd() : body;

  const lines = [heading, "", `Source: ${url}`, "", shown];
  if (truncated) {
    lines.push("", `[content truncated at ${maxChars} characters]`);
  }
  if (!extraction.readabilityUsed) {
    lines.push("", "_Note: no main article content was detected; this is the page's raw text._");
  }
  return lines.join("\n");
}
