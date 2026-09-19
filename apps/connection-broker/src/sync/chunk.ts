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
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
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
    const candidate = [...current, paragraph].join("\n\n");
    if (current.length > 0 && approxTokens(candidate) > maxTokens) flush();

    // A single paragraph over budget on its own cannot be split further here
    // without cutting mid-sentence, so it is kept whole: an oversized chunk
    // retrieves worse than a right-sized one, but a severed sentence is worse
    // than both.
    current.push(paragraph);
  }
  if (current.length > 0) chunks.push(withHeading(current.join("\n\n")));

  return chunks.length > 0 ? chunks : [section];
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
