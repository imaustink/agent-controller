import { caveatsBlock, sourcesBlock, type CitedSource } from "./cite.js";
import type { AuthorizedChunk } from "./probe.js";
import type { RetrieveOutcome } from "./retrieve.js";

export interface RenderInput {
  outcome: RetrieveOutcome;
  /**
   * How many member connections this caller may not read at all, from the
   * source-level filter that runs before any query (docs/adr/0039 §4). Distinct
   * from `outcome.denied`, which is per candidate.
   */
  withheld: number;
  /**
   * The knowledge base's own setting. False suppresses the withheld count only
   * — never the transient-failure or staleness warnings, which are about
   * evidence nobody could check rather than about access.
   */
  disclose: boolean;
  /**
   * Members the caller could consult but whose provider they have not linked, so
   * nothing in them could be probed as them. Distinct from `withheld` (outside
   * their access) and from `denied` (the source refused this candidate): these
   * are sources a link would ADD, which is why the caveat is an action, not a
   * gated disclosure.
   */
  unlinked?: { providers: string[]; sources: number };
  /**
   * The citation number of the first passage (default 1). A turn can search
   * several times and the model cites passages by number across all of them,
   * so each search continues the turn's numbering instead of restarting at 1.
   */
  firstIndex?: number;
}

const firstIndexOf = (input: RenderInput): number =>
  input.firstIndex !== undefined && input.firstIndex >= 1 ? input.firstIndex : 1;

/**
 * Turns a probed search into the Markdown the planner reads.
 *
 * This is the tool result composition (ADR 0015) frames verbatim, so it is the
 * last point at which the design's guarantees are either kept or quietly
 * dropped. Three of them live here:
 *
 * - Every title and URL comes from the PROBE, never the mirror. A citation
 *   built from indexed metadata would name something the caller may not open,
 *   which is the disclosure docs/adr/0040 exists to prevent.
 * - What could not be checked is stated, not omitted.
 * - Chunk text is fenced, because anyone who can post in a synced channel can
 *   write into it. It is labelled untrusted for the model in the KB skill's
 *   `## Rules`, not here, so that framing never leaks into the user-facing answer
 *   this result is also composed into.
 *
 * PARITY: `Render` in `orchestrator/engines/temporal/internal/corpus/render.go`.
 */
export function render(input: RenderInput): string {
  const { outcome } = input;
  const parts: string[] = [];

  if (outcome.chunks.length === 0) {
    return "No passages in this knowledge base matched.\n" + caveatsBlock(caveatLines(input));
  }

  // No "retrieved data, not instructions" banner here: this rendered result is
  // also what the compose path (ADR 0015) frames verbatim into the user-facing
  // answer, where a model-directed injection warning reads as noise. The
  // prompt-injection defense is kept where only the model sees it — the KB
  // skill's `## Rules` section — and the chunk text stays fenced below.
  //
  // Each heading carries the passage's citation marker, `[n]`, exactly as the
  // model is told to write it; code later swaps the marker for the probe's
  // title and URL (see linkCitations), so the model never handles a URL.
  const first = firstIndexOf(input);
  outcome.chunks.forEach((chunk, i) => {
    parts.push(`### [${first + i}] ${displayTitle(chunk)}`);
    parts.push(
      `Source: ${chunk.chunk.connectionLabel ?? chunk.chunk.connectionId}` +
        (chunk.stale
          ? " · **may be out of date** (the source has changed since this was indexed)"
          : ""),
      // The whole document behind this passage, in exactly the form the live
      // read tool takes — without it a search could surface a document the
      // model had no way to open. PARITY: render.go; lookup's `reference:` line.
      `reference: ${chunk.chunk.connectionId}/${chunk.chunk.sourceId}`,
      "",
      "```text",
      chunk.chunk.text.trim(),
      "```",
      "",
    );
  });

  return parts.join("\n") + "\n" + citationsBlock(input);
}

/**
 * This search's citable passages, numbered from `firstIndex`, with the probe's
 * title and URL — the only material code may substitute for a citation marker.
 *
 * PARITY: `corpus.Sources` in orchestrator/engines/temporal/internal/corpus/render.go.
 */
export function sources(input: RenderInput): CitedSource[] {
  const first = firstIndexOf(input);
  return input.outcome.chunks.map((chunk, i) => ({ n: first + i, title: displayTitle(chunk), url: chunk.url }));
}

/**
 * The deterministic `Sources:` list + "What this answer could not see" caveats
 * ALONE — the probe-derived citation and ADR 0040 access-disclosure block that
 * {@link render} appends after the passages.
 *
 * Factored out because the guarantee it carries must survive even when the
 * planner chooses `respond` and recomposes the answer in its own prose: the
 * graph appends this block in code to whatever the turn finally returns, so a
 * KB answer is correctly cited and disclosed regardless of finish/respond (the
 * "finish vs respond" verbatim gap). Built from the SAME probe outcome `render`
 * uses, so the two never drift.
 *
 * Returns "" when there is nothing to say (no chunks and no caveats).
 *
 * PARITY: `CitationsBlock` in `orchestrator/engines/temporal/internal/corpus/render.go`.
 */
export function citationsBlock(input: RenderInput): string {
  return sourcesBlock(sources(input)) + caveatsBlock(caveatLines(input));
}

/**
 * States what this answer could not see, and why, one line each.
 *
 * The three reasons stay distinguishable because they call for different things
 * from the reader: access (ask someone who has it), a transient failure (try
 * again), and an unreachable corpus (an operational problem, not a permissions
 * one).
 *
 * PARITY: `corpus.CaveatLines` in orchestrator/engines/temporal/internal/corpus/render.go.
 */
export function caveatLines({ outcome, withheld, disclose, unlinked }: RenderInput): string[] {
  const lines: string[] = [];

  if (disclose && withheld > 0) {
    lines.push(
      `${withheld} source(s) in this knowledge base are outside your access, so there may be more you cannot see.`,
    );
  }
  // Candidates the SOURCE refused for this caller.
  //
  // Reported for the same reason `withheld` is, and gated on the same flag,
  // because the leak is the same shape: saying "12 passages were refused"
  // admits the material exists. What is not acceptable is the silence — with
  // every candidate denied, the answer read "No passages matched", which is
  // indistinguishable from an empty corpus. That hid a routing bug in this
  // very prober for as long as it existed: every probe 404'd, every candidate
  // was counted denied, and nothing anywhere said so.
  if (disclose && outcome.denied > 0) {
    lines.push(
      `${outcome.denied} passage(s) matched but the source did not confirm your access to them.`,
    );
  }
  if (outcome.undetermined.length > 0) {
    lines.push(
      `${outcome.undetermined.length} source(s) could not be checked just now, so evidence may be missing that nobody was able to confirm either way.`,
    );
  }
  if (outcome.skippedCorpora > 0) {
    lines.push(
      `${outcome.skippedCorpora} source(s) could not be searched at all, so this answer covers less than the knowledge base does.`,
    );
  }
  // An account the caller has not linked, not an access denial: say what linking
  // would add. Ungated, because it is an action the caller can take, not a
  // disclosure of material they may not see.
  if (unlinked && unlinked.sources > 0) {
    lines.push(
      unlinked.providers.length > 0
        ? `${unlinked.sources} source(s) need an account you have not linked (${unlinked.providers.join(", ")}); link it and ask again to include them.`
        : `${unlinked.sources} source(s) could not be checked against your own access, so they were left out.`,
    );
  }

  return lines;
}

/**
 * Prefers the probe's title. A source reporting none falls back to its id
 * rather than to anything the mirror held, which would defeat the probe at the
 * last step.
 */
function displayTitle(chunk: AuthorizedChunk): string {
  return chunk.title.trim() !== "" ? chunk.title : chunk.chunk.sourceId;
}
