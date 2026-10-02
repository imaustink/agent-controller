import { createHash } from "node:crypto";
import type { Document } from "../drivers/types.js";

/**
 * Chunking, which is where retrieval quality actually comes from
 * (docs/adr/0039 §6).
 *
 * The CRD-level knobs are defaults; what matters is cutting on boundaries the
 * source already has. Prose has headings, and a heading is a far better seam
 * than a token count because it is where the author changed subject. Splitting
 * mid-argument produces chunks that retrieve well and answer badly — they match
 * the question and then lack the half of the reasoning that settles it.
 */
export interface ChunkOptions {
  /** Target upper bound, in approximate tokens. */
  maxTokens?: number;
  /** How much adjacent chunks share, so a passage split across a seam is still findable from either side. */
  overlap?: number;
}

export interface Chunk {
  connectionId: string;
  connectionLabel: string;
  sourceId: string;
  sourceUrl: string;
  title: string;
  updatedAt?: string;
  version?: string;
  /**
   * sha256 over the normalized text plus the source it came from.
   *
   * Doubles as the point id (docs/adr/0039 §7), which is what makes a re-sync
   * re-embed only what changed. Including the source id means the same sentence
   * in two documents stays two chunks, while the same chunk of the same
   * document is stable across syncs — the property the whole incremental story
   * rests on.
   */
  contentHash: string;
  /** Principals the mirror pre-filters on, carried from the driver's ACL capture. */
  aclPrincipals?: string[];
  /** True when the driver could not resolve permissions and marked it permissive. */
  aclPermissive?: boolean;
  text: string;
}

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAP = 100;

/**
 * Hard ceiling on the effective chunk target, kept well under the embedding
 * model's 8192-token per-input cap (text-embedding-3-small) to leave room for
 * the heading and overlap a chunk also carries.
 *
 * This is a CAP, not a suggestion: a single chunk over the model's input limit
 * 400s the embed, and the request batcher (embedder.ts) cannot rescue a lone
 * over-cap input — so it fails the whole corpus. A configured `maxTokens` above
 * this is clamped, and any piece still over budget is force-split below, even if
 * that severs a sentence: an un-embeddable chunk is worse than a split one.
 */
const MAX_CHUNK_TOKENS = 6000;

/** Rough token estimate. Deliberately cheap: chunk sizing does not need a tokenizer's precision. */
const approxTokens = (text: string): number => Math.ceil(text.length / 4);

/**
 * Splits a document into chunks.
 *
 * Two passes. First on Markdown headings, because that is the author's own
 * statement of where one idea ends. Then any section still over budget is split
 * on paragraph boundaries with overlap, because a paragraph is the next-best
 * seam and cutting mid-sentence is the thing to avoid.
 *
 * A section under budget is left whole even if it is tiny — merging small
 * sections across a heading would undo the boundary the first pass just
 * respected.
 */
export function chunkDocument(
  connection: { id: string; label: string },
  document: Document,
  options: ChunkOptions = {},
): Chunk[] {
  // Clamped to the model cap: a larger configured target cannot be allowed to
  // emit a chunk the embedder will reject (see MAX_CHUNK_TOKENS).
  const maxTokens = Math.min(options.maxTokens ?? DEFAULT_MAX_TOKENS, MAX_CHUNK_TOKENS);
  const overlap = options.overlap ?? DEFAULT_OVERLAP;

  const sections = splitOnHeadings(document.markdown);
  const pieces: string[] = [];
  for (const section of sections) {
    if (approxTokens(section) <= maxTokens) {
      pieces.push(section);
      continue;
    }
    pieces.push(...splitOnParagraphs(section, maxTokens, overlap));
  }

  return pieces
    .map((text) => text.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({
      connectionId: connection.id,
      connectionLabel: connection.label,
      sourceId: document.id,
      sourceUrl: document.url,
      title: document.title,
      updatedAt: document.updatedAt,
      version: document.version,
      contentHash: hashChunk(connection.id, document.id, text),
      aclPrincipals: document.acl?.principals,
      aclPermissive: document.acl?.permissive,
      text,
    }));
}

/**
 * Content hash over the normalized text AND its source.
 *
 * Normalizing whitespace first means a reflowed paragraph that says the same
 * thing does not read as a change and force a re-embed — which is most of what
 * makes an incremental re-sync cheap in practice, since editors reflow
 * constantly.
 */
export function hashChunk(connectionId: string, sourceId: string, text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return createHash("sha256").update(`${connectionId}\u0000${sourceId}\u0000${normalized}`).digest("hex");
}

/**
 * Splits on Markdown headings, keeping each heading with the body beneath it.
 *
 * The heading travels with its section on purpose: it is usually the most
 * retrievable sentence in it, and a body separated from its heading loses the
 * one line that says what it is about.
 */
function splitOnHeadings(markdown: string): string[] {
  const lines = markdown.split("\n");
  const sections: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    if (/^#{1,6}\s/.test(line) && current.some((l) => l.trim() !== "")) {
      sections.push(current.join("\n"));
      current = [line];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join("\n"));

  return sections.length > 0 ? sections : [markdown];
}

/**
 * Splits an over-budget section on blank lines, carrying `overlap` tokens'
 * worth of the previous chunk's tail into the next.
 *
 * The overlap is what keeps a passage straddling a seam findable from either
 * side. Without it, the one paragraph that answers the question can land
 * exactly on a boundary and match neither chunk well.
 */
function splitOnParagraphs(section: string, maxTokens: number, overlap: number): string[] {
  const paragraphs = section.split(/\n{2,}/);

  // A section's heading is REPEATED onto every piece rather than left to become
  // a chunk of its own. Orphaning it produces a contentless chunk that still
  // matches queries about the topic and then answers nothing — and it strips
  // the remaining pieces of the one line that says what they are about.
  const heading = paragraphs.length > 0 && /^#{1,6}\s/.test(paragraphs[0]!.trim()) ? paragraphs[0]! : undefined;
  const body = heading ? paragraphs.slice(1) : paragraphs;
  const withHeading = (text: string) => (heading ? `${heading}\n\n${text}` : text);

  const chunks: string[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    chunks.push(withHeading(current.join("\n\n")));
    current = overlap > 0 ? tail(current, overlap) : [];
  };

  for (const paragraph of body) {
    // A single paragraph over budget has no blank-line seam to split on, but it
    // still must not exceed the model's input cap — so it is force-split on the
    // next seams down (lines, then words, then a hard character cut). A severed
    // sentence retrieves worse than a clean one, but a chunk that cannot be
    // embedded at all fails the entire corpus, so this is the lesser evil. A
    // paragraph within budget is one unit, unchanged.
    const units = approxTokens(paragraph) > maxTokens ? forceSplit(paragraph, maxTokens) : [paragraph];
    for (const unit of units) {
      const candidate = [...current, unit].join("\n\n");
      if (current.length > 0 && approxTokens(candidate) > maxTokens) flush();
      current.push(unit);
    }
  }
  if (current.length > 0) chunks.push(withHeading(current.join("\n\n")));

  return chunks.length > 0 ? chunks : [section];
}

/**
 * Last-resort split of a seam-less over-budget paragraph: lines, then words,
 * then a hard character cut. Every returned piece is at most `maxTokens`.
 *
 * Only reached when the structural passes left a paragraph over budget — a big
 * spreadsheet extracts to one blank-line-free blob of rows, which this breaks on
 * newlines; a single unbroken run with no line or space is cut by length. Line
 * and word splits rejoin losslessly; the character cut is the final guarantee
 * that no chunk can exceed the embedding model's input cap.
 */
function forceSplit(text: string, maxTokens: number): string[] {
  if (approxTokens(text) <= maxTokens) return [text];

  for (const sep of ["\n", " "]) {
    if (!text.includes(sep)) continue;
    const parts = text.split(sep);
    if (parts.length < 2) continue;

    const out: string[] = [];
    let buf = "";
    for (const part of parts) {
      if (approxTokens(part) > maxTokens) {
        // One line/word longer than the cap on its own — recurse to the next,
        // finer seam (and ultimately the character cut).
        if (buf) {
          out.push(buf);
          buf = "";
        }
        out.push(...forceSplit(part, maxTokens));
        continue;
      }
      const candidate = buf ? buf + sep + part : part;
      if (buf && approxTokens(candidate) > maxTokens) {
        out.push(buf);
        buf = part;
      } else {
        buf = candidate;
      }
    }
    if (buf) out.push(buf);
    return out;
  }

  // An unbroken run with no line or space: the only remaining seam is length.
  const windowChars = Math.max(1, maxTokens * 4);
  const windows: string[] = [];
  for (let i = 0; i < text.length; i += windowChars) windows.push(text.slice(i, i + windowChars));
  return windows;
}

/** The trailing paragraphs of a chunk, up to roughly `overlap` tokens. */
function tail(paragraphs: string[], overlap: number): string[] {
  const kept: string[] = [];
  let budget = overlap;
  for (let i = paragraphs.length - 1; i >= 0 && budget > 0; i -= 1) {
    const paragraph = paragraphs[i]!;
    kept.unshift(paragraph);
    budget -= approxTokens(paragraph);
  }
  return kept;
}
