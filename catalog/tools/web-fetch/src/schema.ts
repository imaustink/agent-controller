import { z } from "zod";

/**
 * This tool's input is a plain URL string -- no structure to validate beyond
 * "non-empty" and a sane upper bound. Scheme/host validation (the part that
 * actually matters for safety) is the SSRF guard's job, not this schema's --
 * see security/url-guard.ts.
 */
export const UrlInputSchema = z.string().trim().min(1, "URL must not be empty").max(2000, "URL is too long");

/** Pipeline stages emitted via the messaging protocol (docs/messaging.md). */
export type FetchStage = "fetch" | "extract";

/** Error taxonomy (plain TS union, not runtime-validated -- same convention as recipe-scraper/web-search). */
export type FetchErrorCode = "usage" | "blocked_url" | "fetch_error" | "extraction_error" | "general";
