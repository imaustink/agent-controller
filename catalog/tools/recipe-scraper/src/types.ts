import type { SourceType } from "./schema.js";

/** Normalized output of every extractor before LLM formatting. */
export interface Extraction {
  /** Raw, untrusted text content extracted from the source. */
  text: string;
  /** Best-effort human title, if available. */
  title: string | null;
  sourceType: SourceType;
  /** Non-sensitive metadata about how the extraction was performed. */
  provenance: Record<string, unknown>;
  /** Non-fatal issues encountered during extraction. */
  warnings: string[];
}
