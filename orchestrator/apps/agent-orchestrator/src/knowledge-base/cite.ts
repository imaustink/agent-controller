/**
 * One citable result: the number the model cites it by, and the title and URL
 * code substitutes for that number.
 *
 * The model only ever writes the number. Title and URL come from the source's
 * own answer to the caller (the probe, or a live search/read run as them), so an
 * inline citation can never name something this caller may not open — the
 * docs/adr/0040 guarantee the appended Sources list used to carry alone.
 *
 * PARITY: `corpus.Source` in orchestrator/engines/temporal/internal/corpus/cite.go.
 */
export interface CitedSource {
  n: number;
  title: string;
  url: string;
}

const SOURCES_HEADER = "Sources:";
const CAVEATS_HEADER = "What this answer could not see:";

/**
 * Lists sources once each, keyed by URL: several passages from one page are one
 * source to the reader, not several identical lines.
 */
export function sourcesBlock(sources: CitedSource[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const source of sources) {
    const key = sourceKey(source);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${sourceLink(source)}`);
  }
  return lines.length === 0 ? "" : `${SOURCES_HEADER}\n${lines.join("\n")}\n`;
}

/** States what the answer could not see, each reason once. */
export function caveatsBlock(lines: string[]): string {
  const unique = [...new Set(lines)];
  return unique.length === 0 ? "" : `\n${CAVEATS_HEADER}\n${unique.map((l) => `- ${l}`).join("\n")}\n`;
}

/**
 * One or more adjacent markers — "[3]", "[3][5]", "[3], [5]", "[3, 5]" — so a
 * cluster becomes one comma-joined list of links.
 */
const CITATION_RUN = /\[\d+(?:\s*[,;]\s*\d+)*\](?:[ \t]*,?[ \t]*\[\d+(?:\s*[,;]\s*\d+)*\])*/g;

/**
 * Replaces the model's `[n]` markers with the cited source's title as a Markdown
 * link, and reports how many distinct sources it linked.
 *
 * A number that names no source is dropped rather than left dangling: one that
 * LOOKS like a citation but points nowhere is worse than none. Markers already
 * part of Markdown link syntax — `[3](…)` or `…][3]` — are left alone.
 */
export function linkCitations(text: string, sources: CitedSource[]): { text: string; used: number } {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const used = new Set<string>();
  let out = "";
  let last = 0;

  for (const match of text.matchAll(CITATION_RUN)) {
    const start = match.index;
    const end = start + match[0].length;
    if (text[end] === "(" || (start > 0 && text[start - 1] === "]")) continue;

    const links: string[] = [];
    const inRun = new Set<string>();
    for (const digits of match[0].match(/\d+/g) ?? []) {
      const source = byN.get(Number(digits));
      if (!source || inRun.has(sourceKey(source))) continue;
      inRun.add(sourceKey(source));
      used.add(sourceKey(source));
      links.push(sourceLink(source));
    }

    let prefix = text.slice(last, start);
    // Nothing valid in this run: remove it, and the space it was attached with,
    // so "OIDC [9]." reads "OIDC." not "OIDC ."
    if (links.length === 0) prefix = prefix.replace(/[ \t]+$/, "");
    // The model often glues a marker to the word it follows ("…with SNC[1].").
    // A bare marker reads fine that way; a title does not, so separate it.
    else if (needsSpaceBefore(text, start)) prefix += " ";
    out += prefix + links.join(", ");
    last = end;
  }
  return { text: out + text.slice(last), used: used.size };
}

/**
 * Turns a synthesized answer into its user-facing form.
 *
 * Markers become inline links. If the model cited nothing it could be held to,
 * the full Sources list is appended instead, so an answer built on retrieved
 * material is never shipped uncited. What the answer could not see is always
 * appended, whatever the model did: that disclosure is not the model's to drop.
 *
 * PARITY: `corpus.FinalizeCitations` in orchestrator/engines/temporal/internal/corpus/cite.go.
 */
export function finalizeCitations(response: string, sources: CitedSource[], caveats: string[]): string {
  let { text, used } = linkCitations(response, sources);
  if (used === 0 && sources.length > 0) {
    text = `${text.replace(/\n+$/, "")}\n\n${sourcesBlock(sources)}`;
  }
  const block = caveatsBlock(caveats);
  if (block && !text.includes(block.trim())) {
    text = `${text.replace(/\n+$/, "")}\n${block}`;
  }
  return text;
}

/**
 * Whether a link replacing the marker at `start` would be glued to the preceding
 * character: anything but the start of the text, whitespace, or an opening
 * bracket/quote the link belongs inside. PARITY: needsSpaceBefore in cite.go.
 */
function needsSpaceBefore(text: string, start: number): boolean {
  return start > 0 && !" \t\n\r([{\"'".includes(text[start - 1]!);
}

function sourceKey(source: CitedSource): string {
  return source.url !== "" ? source.url : `title:${source.title}`;
}

/** A source as a Markdown link, escaped so a title or URL cannot break out of the syntax. */
function sourceLink(source: CitedSource): string {
  const title = source.title.replace(/[\\[\]]/g, (c) => `\\${c}`);
  if (source.url === "") return title;
  const url = source.url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[${title}](${url})`;
}
