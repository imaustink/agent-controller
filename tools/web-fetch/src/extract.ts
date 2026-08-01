import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import type { SafeUrl } from "./security/url-guard.js";
import { downloadText } from "./util/download.js";

export interface Extraction {
  title: string | null;
  text: string;
  readabilityUsed: boolean;
}

export class ExtractionError extends Error {}

/**
 * Downloads a page's HTML (via the SSRF-guarded fetch) and extracts its main
 * article text with Readability, same library tools/recipe-scraper uses for
 * its own web extractor. Unlike that tool this one never launches a browser --
 * it only sees whatever HTML the server returns for a plain GET, so
 * JS-rendered content that isn't present in the initial response won't show
 * up here (see README's known limitations).
 *
 * JSDOM parses the markup without executing scripts (the default, and never
 * overridden here) -- untrusted page content is inert data, not code.
 */
export async function extractPage(safe: SafeUrl): Promise<Extraction> {
  const { text: html, contentType } = await downloadText(safe.url.toString());

  if (contentType && !contentType.includes("html") && !contentType.includes("xml") && contentType !== "text/plain") {
    throw new ExtractionError(`Unsupported content-type for extraction: ${contentType || "unknown"}`);
  }

  let dom: JSDOM;
  try {
    dom = new JSDOM(html, { url: safe.url.toString() });
  } catch (err) {
    throw new ExtractionError(`Failed to parse page HTML: ${(err as Error).message}`);
  }

  const pageTitle = dom.window.document.title?.trim() || null;
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  let text = article?.textContent?.trim() ?? "";
  let readabilityUsed = Boolean(text);
  if (!text) {
    text = dom.window.document.body?.textContent?.trim() ?? "";
    readabilityUsed = false;
  }

  return {
    title: article?.title?.trim() || pageTitle,
    text,
    readabilityUsed,
  };
}
